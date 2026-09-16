const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const PRICES = require('./prices.json');

const app = express();
app.use(cors());
app.use(express.json());
app.use(helmet({ contentSecurityPolicy: false })); // Paystack needs this off

// ══════════════════════════════════════════
// FIREBASE
// ══════════════════════════════════════════
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
console.log('✅ Firebase connected');

// ══════════════════════════════════════════
// ENV
// ══════════════════════════════════════════
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const DATABOSSHUB_BASE_URL = process.env.DATABOSSHUB_BASE_URL || 'https://bbhubportal.com/api/v1';
const DATABOSSHUB_API_KEY = process.env.DATABOSSHUB_API_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;

// Add phone numbers here if you ever need to block a specific number from ordering
const BLOCKED_NUMBERS = [];

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many attempts. Please wait a few minutes and try again.' }
});

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════
function generateOrderRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `BVX-${code}`;
}

function getWhatsAppLink(phoneNumber, message) {
  let formatted = phoneNumber.toString().replace(/\s/g, '');
  if (formatted.startsWith('0')) formatted = '233' + formatted.substring(1);
  return `https://wa.me/${formatted}?text=${encodeURIComponent(message)}`;
}

function getOrderMessage(orderRef, bundle, network, amount) {
  return `🛍️ *Order Received*\n\n✅ Order: ${orderRef}\n📱 Network: ${network}\n📦 Bundle: ${bundle}\n💰 Amount: GHS ${amount}\n⏰ Time: ${new Date().toLocaleString('en-GH')}\n\nYou'll get an SMS when your order is delivered.`;
}

function getBundle(network, size) {
  return PRICES[network] && PRICES[network][size] ? PRICES[network][size] : null;
}

const PROCESSING_FEE_RATE = 0.02; // 2% card fee, same as your old site

function getTotalWithFee(price) {
  return Math.round(price * (1 + PROCESSING_FEE_RATE) * 100) / 100;
}

function listBundles() {
  const result = [];
  Object.keys(PRICES).forEach(network => {
    Object.keys(PRICES[network]).forEach(size => {
      const b = PRICES[network][size];
      result.push({
        network, size,
        price: b.price,
        validity: b.validity,
        total_with_fee: getTotalWithFee(b.price)
      });
    });
  });
  return result;
}

// ── DataBossHub ──
async function databosshubFetch(path, options) {
  try {
    const res = await fetch(`${DATABOSSHUB_BASE_URL}${path}`, options);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      console.error(`❌ DataBossHub non-JSON (${res.status}) from ${path}: ${text.substring(0, 200)}`);
      return { success: false, error: 'DataBossHub service returned an unexpected response.' };
    }
    const data = await res.json();
    const ok = res.ok && data.status !== 'error' && data.status !== false;
    return { success: ok, ...data };
  } catch (e) {
    console.error(`❌ DataBossHub fetch error from ${path}:`, e.message);
    return { success: false, error: 'DataBossHub service is currently unavailable.' };
  }
}

function purchaseData({ network, planName, recipient }) {
  return databosshubFetch('/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': DATABOSSHUB_API_KEY },
    body: JSON.stringify({ network, data_plan: planName, beneficiary: recipient })
  });
}

function getOrderStatus(reference) {
  return databosshubFetch(`/order-status/${reference}`, { headers: { 'X-API-KEY': DATABOSSHUB_API_KEY } });
}

function verifyNumbers(phoneNumbers) {
  return databosshubFetch('/checker/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': DATABOSSHUB_API_KEY },
    body: JSON.stringify({ phoneNumbers })
  });
}

function getBalance() {
  return databosshubFetch('/balance', { headers: { 'X-API-KEY': DATABOSSHUB_API_KEY } });
}

// ── Paystack ──
async function initializeTransaction({ email, amount, metadata, callback_url }) {
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount: Math.round(amount * 100), currency: 'GHS', metadata, callback_url })
  });
  return res.json();
}

async function verifyTransaction(reference) {
  const res = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
    headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` }
  });
  return res.json();
}

// ══════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════

app.get('/health', (req, res) => res.json({ status: '🚀 running' }));

app.get('/api/bundles', (req, res) => {
  res.json({ success: true, data: listBundles() });
});

app.get('/api/balance', async (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
  res.json(await getBalance());
});

app.post('/api/checkout/initialize', checkoutLimiter, async (req, res) => {
  const { network, size, recipient, email } = req.body;

  if (!network || !size || !recipient) {
    return res.json({ success: false, error: 'Network, bundle size, and recipient number are required.' });
  }
  if (!/^0[0-9]{9}$/.test(recipient)) {
    return res.json({ success: false, error: 'Enter a valid 10-digit number starting with 0.' });
  }
  if (BLOCKED_NUMBERS.includes(recipient)) {
    return res.json({ success: false, error: 'This number cannot be used for orders. Contact support.' });
  }

  const bundle = getBundle(network, size);
  if (!bundle) return res.json({ success: false, error: 'That bundle is not available.' });

  const totalWithFee = getTotalWithFee(bundle.price);
  const payerEmail = email && email.includes('@') ? email : `${recipient}@byvox.customer`;

  try {
    const paystackRes = await initializeTransaction({
      email: payerEmail,
      amount: totalWithFee,
      metadata: { network, size, recipient },
      callback_url: `${FRONTEND_URL}/?payment_status=success`
    });

    if (!paystackRes.status) {
      return res.json({ success: false, error: paystackRes.message || 'Could not start payment.' });
    }

    res.json({ success: true, authorization_url: paystackRes.data.authorization_url, reference: paystackRes.data.reference });
  } catch (e) {
    console.error('Checkout init error:', e);
    res.status(500).json({ success: false, error: 'Service temporarily unavailable. Please try again.' });
  }
});

app.post('/api/checkout/verify', async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.json({ success: false, error: 'Reference is required.' });

  try {
    const existingSnap = await db.ref('orders').orderByChild('reference').equalTo(reference).once('value');
    if (existingSnap.exists()) {
      return res.json({ success: true, data: Object.values(existingSnap.val())[0], already_processed: true });
    }

    const paystackData = await verifyTransaction(reference);
    if (!paystackData.data || paystackData.data.status !== 'success') {
      return res.json({ success: false, error: 'Payment not verified.' });
    }

    const amountPaid = paystackData.data.amount / 100;
    const { network, size, recipient } = paystackData.data.metadata || {};

    const bundle = getBundle(network, size);
    if (!bundle) return res.json({ success: false, error: 'Could not verify bundle price. Please contact support.' });

    const expectedTotal = getTotalWithFee(bundle.price);
    if (Math.abs(amountPaid - expectedTotal) > 0.05) {
      console.error(`❌ PRICE MISMATCH: paid ${amountPaid}, expected ${expectedTotal} (${network} ${size})`);
      await db.ref('suspicious_activities').push({
        recipient, amount_paid: amountPaid, expected_amount: expectedTotal, network, size, reference,
        timestamp: new Date().toISOString()
      });
      return res.json({ success: false, error: 'Payment amount did not match bundle price. This has been logged.' });
    }

    let eligibilityNote = null;
    if (network === 'MTN' || network === 'Express(MTN)') {
      const verifyResult = await verifyNumbers([recipient]);
      if (verifyResult.success) eligibilityNote = verifyResult.data || verifyResult.results || null;
    }

    const orderResult = await purchaseData({ network, planName: bundle.plan_name, recipient });

    const orderRef = generateOrderRef();
    let status;
    if (!orderResult.success) status = 'failed';
    else if (network === 'MTN Unverified') status = 'pending_manual'; // see note in README re: unconfirmed docs
    else status = 'processing';

    const waMessage = getOrderMessage(orderRef, size, network, bundle.price);
    const waLink = getWhatsAppLink(recipient, waMessage);

    const order = {
      reference: orderRef,
      paystack_reference: reference,
      network, size, recipient,
      amount_paid: amountPaid,
      bundle_price: bundle.price,
      status,
      databosshub_reference: orderResult.data?.reference || orderResult.reference || null,
      databosshub_purchase_id: orderResult.data?.purchase_id || null,
      eligibility_check: eligibilityNote,
      databosshub_raw_error: orderResult.success ? null : (orderResult.error || orderResult.message || 'Unknown error'),
      whatsapp_link: waLink,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await db.ref('orders').push(order);

    res.json({
      success: orderResult.success,
      data: order,
      message: !orderResult.success
        ? 'Payment received, but the order could not be placed automatically. Support has been notified.'
        : status === 'pending_manual'
          ? 'Order received. This number needs manual verification, so delivery may take longer than usual.'
          : 'Order placed! Data will be delivered shortly.'
    });
  } catch (e) {
    console.error('Verify error:', e.message);
    res.status(500).json({ success: false, error: 'Service temporarily unavailable. Please try again.' });
  }
});

app.get('/api/track/:reference', async (req, res) => {
  try {
    const snap = await db.ref('orders').orderByChild('reference').equalTo(req.params.reference).once('value');
    if (!snap.exists()) return res.json({ success: false, error: 'Order not found.' });

    const [key, order] = Object.entries(snap.val())[0];

    if (['processing', 'pending_manual'].includes(order.status) && order.databosshub_reference) {
      const live = await getOrderStatus(order.databosshub_reference);
      if (live.success && live.data?.status && live.data.status.toLowerCase() !== order.status) {
        const newStatus = live.data.status.toLowerCase();
        await db.ref(`orders/${key}`).update({ status: newStatus, updated_at: new Date().toISOString() });
        order.status = newStatus;
      }
    }

    res.json({ success: true, order });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Service temporarily unavailable. Please try again.' });
  }
});

app.get('/api/track-by-phone/:phone', async (req, res) => {
  try {
    const snap = await db.ref('orders').orderByChild('recipient').equalTo(req.params.phone).once('value');
    const orders = snap.exists() ? Object.values(snap.val()).reverse() : [];
    res.json({ success: true, orders });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Service temporarily unavailable. Please try again.' });
  }
});

// Placeholder — no webhook confirmed in DataBossHub's docs yet, tracking polls live status instead
app.post('/webhook/databosshub', async (req, res) => {
  try {
    const { reference, status } = req.body;
    if (reference && status) {
      const snap = await db.ref('orders').orderByChild('databosshub_reference').equalTo(reference).once('value');
      if (snap.exists()) {
        const [key] = Object.entries(snap.val())[0];
        await db.ref(`orders/${key}`).update({ status: status.toLowerCase(), updated_at: new Date().toISOString() });
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
