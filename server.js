require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ══════════════════════════════════════════════════════════════
// ENV
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const PORTAL_URL = process.env.PORTAL_URL || '*';
const BACKEND_URL = process.env.BACKEND_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATAHUB_API_KEY = process.env.DATAHUB_API_KEY;
const DATAHUB_BASE_URL = process.env.DATAHUB_BASE_URL || 'https://app.datahubgh.com/api/external';
const DATABOSSHUB_API_KEY = process.env.DATABOSSHUB_API_KEY;
const DATABOSSHUB_BASE_URL = process.env.DATABOSSHUB_BASE_URL || 'https://bbhubportal.com/api/v1';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ══════════════════════════════════════════════════════════════
// FIREBASE
// ══════════════════════════════════════════════════════════════
admin.initializeApp({
  credential: admin.credential.cert({
    type: 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = admin.database();

const fb = {
  async get(path) { return (await db.ref(path).once('value')).val(); },
  async set(path, data) { await db.ref(path).set(data); },
  async update(path, data) { await db.ref(path).update(data); },
  async push(path, data) { return (await db.ref(path).push(data)).key; },
  async remove(path) { await db.ref(path).remove(); },
  async findOneBy(path, child, value) {
    const snap = await db.ref(path).orderByChild(child).equalTo(value).once('value');
    if (!snap.exists()) return [null, null];
    const [key, val] = Object.entries(snap.val())[0];
    return [key, val];
  },
  async findAllBy(path, child, value) {
    const snap = await db.ref(path).orderByChild(child).equalTo(value).once('value');
    if (!snap.exists()) return [];
    return Object.entries(snap.val()).map(([key, val]) => ({ key, ...val }));
  },
};

// ══════════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════════
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(len) { let s = ''; for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }
function generateId() { return Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function generateOrderRef() { return `BVX-${randomCode(6)}`; }
function calculateProcessingFee(amount) { return amount <= 0 ? 0 : Math.round(amount * 0.02 * 100) / 100; }
function calculateTotalWithFee(amount) { return amount <= 0 ? 0 : Math.round(amount * 1.02 * 100) / 100; }
function normalizePhone(phone) { return String(phone || '').replace(/\s|-/g, ''); }
function isValidGhPhone(phone) { return /^0[0-9]{9}$/.test(normalizePhone(phone)); }
function whatsappMessage(orderRef, bundle, network, amount) {
  return `Byvox Data - Order Received\n\nOrder: ${orderRef}\nNetwork: ${network}\nBundle: ${bundle}\nAmount: GHS ${amount}\nTime: ${new Date().toLocaleString('en-GH')}\n\nYou will receive an SMS when your order is delivered.\n\nThank you for your purchase.`;
}
function whatsappLink(phoneNumber, message) {
  let formatted = normalizePhone(phoneNumber);
  if (formatted.startsWith('0')) formatted = '233' + formatted.substring(1);
  return `https://wa.me/${formatted}?text=${encodeURIComponent(message)}`;
}

// ══════════════════════════════════════════════════════════════
// DATAHUB CLIENT (rate-limited + retried)
// ══════════════════════════════════════════════════════════════
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Throttle {
  constructor(maxPerMinute) { this.max = maxPerMinute; this.timestamps = []; this.queue = []; this.running = false; }
  run(fn) { return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this._drain(); }); }
  async _drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 60000);
      if (this.timestamps.length >= this.max) { await sleep(60000 - (now - this.timestamps[0]) + 50); continue; }
      const job = this.queue.shift();
      this.timestamps.push(Date.now());
      try { job.resolve(await job.fn()); } catch (err) { job.reject(err); }
    }
    this.running = false;
  }
}
const throttles = { verify: new Throttle(25), beneficiaries: new Throttle(16), purchase: new Throttle(25) };

async function safeFetchJson(url, options, attempt = 1) {
  const maxAttempts = 3;
  try {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-API-Key': DATAHUB_API_KEY, ...(options.headers || {}) } });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      console.error(`[datahub] non-JSON response (${res.status}) from ${url}: ${text.slice(0, 200)}`);
      if (res.status >= 500 && attempt < maxAttempts) { await sleep(attempt * 1000); return safeFetchJson(url, options, attempt + 1); }
      return { success: false, error: 'DataHub service is currently unavailable. Please try again later.', httpStatus: res.status };
    }
    return { ...(await res.json()), httpStatus: res.status };
  } catch (err) {
    console.error(`[datahub] fetch error on ${url}:`, err.message);
    if (attempt < maxAttempts) { await sleep(attempt * 1000); return safeFetchJson(url, options, attempt + 1); }
    return { success: false, error: 'Service temporarily unavailable. Please try again later.' };
  }
}

const datahub = {
  verify: (networkKey, recipient, isPortedNumber = true) => throttles.verify.run(() =>
    safeFetchJson(`${DATAHUB_BASE_URL}/verify`, { method: 'POST', body: JSON.stringify({ networkKey, recipient, is_ported_number: isPortedNumber }) })),
  submitBeneficiaries: (numbers) => throttles.beneficiaries.run(() =>
    safeFetchJson(`${DATAHUB_BASE_URL}/beneficiaries`, { method: 'POST', body: JSON.stringify({ numbers: Array.isArray(numbers) ? numbers : [numbers] }) })),
  purchase: (networkKey, recipient, capacity) => throttles.purchase.run(() =>
    safeFetchJson(`${DATAHUB_BASE_URL}/data-purchase`, { method: 'POST', body: JSON.stringify({ networkKey, recipient, capacity: String(capacity) }) })),
  MTN_NETWORKS: new Set(['YELLO', 'mtn_xpress']),
};

// A number only ever needs to be submitted to DataHub's beneficiary queue once.
// This tracks that per phone number in Firebase so repeat orders (or repeat
// manual "submit for verification" clicks) don't resubmit endlessly.
// Fire-and-forget by design — DataHub's own approval can take weeks to months,
// so this never blocks order creation or delivery; DataBossHub handles the
// actual delivery in the meantime (see attemptDataBossPurchase below). Once
// DataHub eventually approves the number on its own, future orders for it will
// naturally route back to the cheaper/faster DataHub path via the /verify check.
async function submitToDataHubInBackground(phone) {
  try {
    const path = `datahub_verification_submissions/${phone}`;
    const existing = await fb.get(path);
    if (existing) return existing; // already submitted successfully before — don't resubmit

    const res = await datahub.submitBeneficiaries([phone]);
    const record = {
      phone,
      submitted: !!res.success,
      response: res.error || res.message || null,
      submitted_at: new Date().toISOString(),
    };
    // Only cache on success — a failed attempt (rate limit, transient error,
    // etc.) should be retried on the next order or button click, not stuck.
    if (record.submitted) await fb.set(path, record);
    return record;
  } catch (err) {
    console.error('[datahub submission] error:', err.message);
    return { phone, submitted: false, response: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// DATABOSSHUB CLIENT — fallback provider for MTN numbers DataHub can't verify.
// Response envelope is { status: "success"|"error", data: {...}, meta: {...} },
// different shape from DataHub's { success, data }, so this client normalizes
// it to the same { success, data, error } shape the rest of the app expects.
// ══════════════════════════════════════════════════════════════
async function safeDataBossFetch(url, options, attempt = 1) {
  const maxAttempts = 3;
  try {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-API-KEY': DATABOSSHUB_API_KEY, ...(options.headers || {}) } });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      console.error(`[databosshub] non-JSON response (${res.status}) from ${url}: ${text.slice(0, 200)}`);
      if (res.status >= 500 && attempt < maxAttempts) { await sleep(attempt * 1000); return safeDataBossFetch(url, options, attempt + 1); }
      return { success: false, error: 'DataBossHub service is currently unavailable. Please try again later.' };
    }
    const json = await res.json();
    if (json.status !== 'success') return { success: false, error: json.data?.message || 'DataBossHub rejected the request.', code: json.data?.code };
    return { success: true, data: json.data };
  } catch (err) {
    console.error(`[databosshub] fetch error on ${url}:`, err.message);
    if (attempt < maxAttempts) { await sleep(attempt * 1000); return safeDataBossFetch(url, options, attempt + 1); }
    return { success: false, error: 'Service temporarily unavailable. Please try again later.' };
  }
}

const databosshubThrottle = new Throttle(20); // no published limit — stay conservative

const databosshub = {
  placeOrder: (dataPlan, beneficiary) => databosshubThrottle.run(() =>
    safeDataBossFetch(`${DATABOSSHUB_BASE_URL}/order`, { method: 'POST', body: JSON.stringify({ network: 'MTN Unverified', data_plan: dataPlan, beneficiary }) })),
  checkOrderStatus: (reference) => databosshubThrottle.run(() =>
    safeDataBossFetch(`${DATABOSSHUB_BASE_URL}/order-status?reference=${encodeURIComponent(reference)}`, { method: 'GET' })),
};

// ══════════════════════════════════════════════════════════════
// PAYSTACK CLIENT
// ══════════════════════════════════════════════════════════════
const paystack = {
  async initializeTransaction({ email, amountPesewas, currency = 'GHS', metadata = {}, callback_url }) {
    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, amount: amountPesewas, currency, metadata, callback_url }),
    });
    return res.json();
  },
  async verifyTransaction(reference) {
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });
    return res.json();
  },
  verifyWebhookSignature(rawBody, signature) {
    if (!signature) return false;
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
    return hash === signature;
  },
};

// ══════════════════════════════════════════════════════════════
// ADMIN AUTH (JWT) — the only auth in v1, there's no customer/reseller login
// ══════════════════════════════════════════════════════════════
function signAdminToken() { return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' }); }

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('wrong role');
    next();
  } catch (e) { return res.status(401).json({ success: false, error: 'Invalid or expired admin session' }); }
}

// ══════════════════════════════════════════════════════════════
// ORDER STATE MACHINE — dual provider
//
// PENDING → PROCESSING → SUCCESSFUL | FAILED
//                       ↘ MANUAL_REVIEW (DataBossHub order stuck too long)
//
// Every MTN order is checked against DataHub's /verify on arrival:
//   verified      → fulfilled by DataHub (fast, existing behavior, unchanged)
//   NOT verified  → fulfilled by DataBossHub's "MTN Unverified" product instead
//                    (a few days, not weeks — DataHub's own unverified/beneficiary
//                    path is deprecated and no longer used at all)
// A phone number that's ever been routed to DataBossHub naturally keeps routing
// there on every future order too — we never submit it to DataHub's beneficiary
// queue any more, so it will never become DataHub-verified on its own.
// ══════════════════════════════════════════════════════════════
const DATABOSS_POLL_MS = 2 * 60 * 60 * 1000; // check pending DataBossHub orders every 2 hours
const DATABOSS_MAX_DAYS = 7; // beyond this, flag for manual review instead of polling forever

// DataHub bundle size (e.g. "1", "2", "5", "10") → DataBossHub's plan_name format ("1 GB").
// Extend this if you add bundle sizes DataBossHub doesn't offer under MTN Unverified
// (1,2,3,4,5,10,20,25,30 GB at time of writing) — an order for a size with no mapping
// here will fail cleanly with a clear error instead of silently sending a bad request.
const DATABOSS_MTN_PLAN_MAP = {
  '1': '1 GB', '2': '2 GB', '3': '3 GB', '4': '4 GB', '5': '5 GB',
  '10': '10 GB', '20': '20 GB', '25': '25 GB', '30': '30 GB',
};

async function createOrder(details) {
  const orderId = generateId();
  const reference = generateOrderRef();
  const processingFee = calculateProcessingFee(details.basePrice);

  const order = {
    id: orderId,
    reference,
    paystack_reference: details.paystackReference,
    datahub_reference: null,
    fulfillment_provider: null, // 'datahub' | 'databosshub', set once routed
    network: details.network,
    bundle: details.bundle,
    capacity: details.capacity,
    recipient: details.recipient,
    amount_paid: details.amountPaid,
    base_price: details.basePrice,
    processing_fee: processingFee,
    datahub_cost: 0,
    profit: 0,
    status: 'PENDING',
    is_new_number: false,
    whatsapp_link: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await fb.set(`orders/${orderId}`, order);
  await routeOrder(order);
  return fb.get(`orders/${orderId}`);
}

async function routeOrder(order) {
  if (!datahub.MTN_NETWORKS.has(order.network)) return attemptDataHubPurchase(order);

  const verifyRes = await datahub.verify(order.network, order.recipient, true);
  if (verifyRes.success && verifyRes.data?.exists) return attemptDataHubPurchase(order);

  // Unverified: fire off the DataHub beneficiary submission in the background
  // (so the number eventually becomes properly verified there too — cheaper,
  // for future orders) while delivering THIS order via DataBossHub right now.
  submitToDataHubInBackground(order.recipient).catch((err) => console.error('[datahub submission] unexpected error:', err.message));
  return attemptDataBossPurchase(order);
}

async function attemptDataHubPurchase(order) {
  const res = await datahub.purchase(order.network, order.recipient, order.capacity);

  if (!res.success) {
    await fb.update(`orders/${order.id}`, { status: 'FAILED', fulfillment_provider: 'datahub', datahub_message: res.error || res.message || 'Purchase rejected', updated_at: new Date().toISOString() });
    return fb.get(`orders/${order.id}`);
  }

  const datahubCost = res.balance?.deducted || 0;
  const link = whatsappLink(order.recipient, whatsappMessage(order.reference, order.bundle, order.network, order.amount_paid));

  await fb.update(`orders/${order.id}`, {
    status: 'PROCESSING',
    fulfillment_provider: 'datahub',
    datahub_reference: res.data?.reference || null,
    datahub_status: res.data?.status || null,
    datahub_cost: datahubCost,
    profit: order.amount_paid - datahubCost,
    whatsapp_link: link,
    updated_at: new Date().toISOString(),
  });

  return fb.get(`orders/${order.id}`);
}

async function attemptDataBossPurchase(order) {
  const plan = DATABOSS_MTN_PLAN_MAP[String(order.capacity)];
  if (!plan) {
    await fb.update(`orders/${order.id}`, { status: 'MANUAL_REVIEW', fulfillment_provider: 'databosshub', datahub_message: `No DataBossHub plan mapping for bundle size "${order.capacity}" — add it to DATABOSS_MTN_PLAN_MAP.`, updated_at: new Date().toISOString() });
    return fb.get(`orders/${order.id}`);
  }

  const res = await databosshub.placeOrder(plan, order.recipient);

  if (!res.success) {
    await fb.update(`orders/${order.id}`, { status: 'FAILED', fulfillment_provider: 'databosshub', datahub_message: res.error || 'DataBossHub rejected the order', updated_at: new Date().toISOString() });
    return fb.get(`orders/${order.id}`);
  }

  const link = whatsappLink(order.recipient, whatsappMessage(order.reference, order.bundle, order.network, order.amount_paid));

  // Unverified-number orders take days, not minutes — is_new_number drives the
  // "may take a few days" messaging on the frontend instead of fast-delivery copy.
  await fb.update(`orders/${order.id}`, {
    status: 'PROCESSING',
    fulfillment_provider: 'databosshub',
    is_new_number: true,
    databoss_reference: res.data?.reference || null,
    databoss_status: res.data?.status || null,
    databoss_plan: plan,
    whatsapp_link: link,
    updated_at: new Date().toISOString(),
  });

  return fb.get(`orders/${order.id}`);
}

async function applyStatusUpdate(orderId, newStatus, extra = {}) {
  const order = await fb.get(`orders/${orderId}`);
  if (!order) return null;
  if (order.status === 'SUCCESSFUL' || order.status === 'FAILED') return order; // already terminal
  await fb.update(`orders/${orderId}`, { status: newStatus, updated_at: new Date().toISOString(), ...extra });
  return fb.get(`orders/${orderId}`);
}

// Background poller for orders fulfilled by DataBossHub — these take days, so
// this checks infrequently rather than the tight loop DataHub's flow used.
async function pollDataBossOrders() {
  try {
    const orders = (await fb.get('orders')) || {};
    const now = Date.now();

    for (const [orderId, order] of Object.entries(orders)) {
      if (order.fulfillment_provider !== 'databosshub' || order.status !== 'PROCESSING') continue;
      if (!order.databoss_reference) continue;

      const daysWaiting = (now - new Date(order.created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysWaiting > DATABOSS_MAX_DAYS) {
        await applyStatusUpdate(orderId, 'MANUAL_REVIEW', { datahub_message: `DataBossHub order not resolved after ${DATABOSS_MAX_DAYS} days — check manually.` });
        continue;
      }

      const statusRes = await databosshub.checkOrderStatus(order.databoss_reference);
      if (!statusRes.success) continue; // transient error — try again next poll

      const providerStatus = statusRes.data?.status;
      if (providerStatus === 'completed') {
        await applyStatusUpdate(orderId, 'SUCCESSFUL', { databoss_status: providerStatus });
      } else if (providerStatus && !['pending_wallet', 'processing'].includes(providerStatus)) {
        // Unrecognized status — don't guess success/failure, flag for a human.
        await fb.update(`orders/${orderId}`, { databoss_status: providerStatus, status: 'MANUAL_REVIEW', datahub_message: `Unrecognized DataBossHub status "${providerStatus}" — check manually.`, updated_at: new Date().toISOString() });
      } else if (providerStatus) {
        await fb.update(`orders/${orderId}`, { databoss_status: providerStatus, updated_at: new Date().toISOString() });
      }
    }
  } catch (err) { console.error('[databoss poller] error:', err.message); }
}

// ══════════════════════════════════════════════════════════════
// EXPRESS APP
// ══════════════════════════════════════════════════════════════
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: PORTAL_URL, credentials: true }));
app.use('/webhook/paystack', express.raw({ type: 'application/json' })); // needs raw body for signature check
app.use(express.json());
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { success: false, error: 'Too many attempts. Try again later.' } });

// network key used in the DataHub purchase call → key used under prices/customer/*
const NETWORK_PRICE_KEY = { YELLO: 'mtn', mtn_xpress: 'mtn', AT_PREMIUM: 'AT_PREMIUM', TELECEL: 'telecel', AT_BIGTIME: 'AT_BIGTIME' };
async function isBlocked(phone) { return (await fb.get(`blocked_numbers/${phone}`)) === true; }

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'byvox-backend', time: new Date().toISOString() }));

// ── Public pricing / announcements ──

app.get('/prices', async (req, res) => {
  const prices = (await fb.get('prices/customer')) || {};
  const result = [];
  Object.keys(prices).forEach((network) => Object.keys(prices[network] || {}).forEach((size) => {
    result.push({ network, size, price: prices[network][size].price, validity: prices[network][size].validity, capacity: prices[network][size].capacity });
  }));
  res.json({ success: true, data: result });
});

app.get('/announcements/active', async (req, res) => {
  const announcement = await fb.get('announcements/active');
  res.json({ success: true, announcement: announcement && announcement.is_active !== false ? announcement : null });
});

// ── Payments & orders (the entire customer-facing purchase flow) ──

app.post('/payment/initialize', async (req, res) => {
  const { network, bundle, capacity, recipient, email } = req.body;
  if (!network || !bundle || !capacity || !recipient) return res.json({ success: false, error: 'network, bundle, capacity and recipient are required' });
  if (!isValidGhPhone(recipient)) return res.json({ success: false, error: 'Enter a valid 10-digit phone number starting with 0' });
  if (await isBlocked(recipient)) return res.json({ success: false, error: 'This number cannot be processed. Please contact support.' });

  const priceKey = NETWORK_PRICE_KEY[network];
  if (!priceKey) return res.json({ success: false, error: 'Unsupported network' });

  const priceData = await fb.get(`prices/customer/${priceKey}/${bundle}`);
  if (!priceData || !priceData.price) return res.json({ success: false, error: 'Bundle not available. Please pick another package.' });

  const totalToCharge = calculateTotalWithFee(priceData.price);

  const paystackRes = await paystack.initializeTransaction({
    email: email || 'customer@byvoxdata.com',
    amountPesewas: Math.round(totalToCharge * 100),
    metadata: { purpose: 'data_purchase', network, bundle, capacity, recipient },
    callback_url: `${PORTAL_URL}/checkout.html?payment_status=success`,
  });
  if (!paystackRes.status) return res.json({ success: false, error: paystackRes.message || 'Could not start payment' });

  res.json({ success: true, authorization_url: paystackRes.data.authorization_url, reference: paystackRes.data.reference, amount: totalToCharge });
});

app.post('/payment/verify', async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.json({ success: false, error: 'reference is required' });

  // Idempotency: replayed verifies (or a slow double-click) just return the existing order.
  const [existingKey, existingOrder] = await fb.findOneBy('orders', 'paystack_reference', reference);
  if (existingKey) return res.json({ success: true, data: { ...existingOrder, order_status: existingOrder.status } });

  const paystackData = await paystack.verifyTransaction(reference);
  if (!paystackData.data || paystackData.data.status !== 'success') return res.json({ success: false, error: 'Payment not verified' });

  const amountPaid = paystackData.data.amount / 100;
  const { network, bundle, capacity, recipient } = paystackData.data.metadata || {};
  if (!network || !bundle || !recipient) return res.json({ success: false, error: `Payment metadata incomplete. Contact support with reference ${reference}` });
  if (await isBlocked(recipient)) return res.json({ success: false, error: 'This number has been blocked for security reasons.' });

  const priceKey = NETWORK_PRICE_KEY[network];
  const officialPriceData = await fb.get(`prices/customer/${priceKey}/${bundle}`);
  if (!officialPriceData || !officialPriceData.price) return res.json({ success: false, error: 'Could not verify bundle price. Please contact support.' });

  // Always trust Firebase's price, never the client/metadata-supplied amount.
  const officialPrice = officialPriceData.price;
  const expectedTotal = calculateTotalWithFee(officialPrice);
  if (Math.abs(amountPaid - expectedTotal) > 0.05) {
    await fb.push('suspicious_activities', { recipient, amount_paid: amountPaid, expected_amount: expectedTotal, network, bundle, reference, timestamp: new Date().toISOString() });
    return res.json({ success: false, error: 'Payment amount does not match bundle price. This has been logged for review.' });
  }

  const order = await createOrder({ paystackReference: reference, network, bundle, capacity, recipient, amountPaid, basePrice: officialPrice });

  let message;
  if (order.status === 'FAILED') message = 'Your payment was received, but we could not place your order. Please contact support.';
  else if (order.fulfillment_provider === 'databosshub') message = 'Your number is new, so it needs to go through network verification first. This takes up to 2–3 working days, and your data will be delivered automatically as soon as verification is complete — no action needed from you.';
  else message = 'Order placed successfully! Data will be delivered shortly.';

  res.json({ success: order.status !== 'FAILED', data: { ...order, order_status: order.status, order_reference: order.reference, message } });
});

app.get('/track-order/:reference', async (req, res) => {
  const [, order] = await fb.findOneBy('orders', 'reference', req.params.reference);
  if (!order) return res.json({ success: false, error: 'Order not found' });
  res.json({ success: true, order });
});

app.get('/track-by-phone/:phone', async (req, res) => {
  const orders = await fb.findAllBy('orders', 'recipient', req.params.phone);
  orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ success: true, orders });
});

app.get('/order/whatsapp-link/:reference', async (req, res) => {
  const [key, order] = await fb.findOneBy('orders', 'reference', req.params.reference);
  if (!order) return res.json({ success: false, error: 'Order not found' });
  let link = order.whatsapp_link;
  if (!link) { link = whatsappLink(order.recipient, whatsappMessage(order.reference, order.bundle, order.network, order.amount_paid)); await fb.update(`orders/${key}`, { whatsapp_link: link }); }
  res.json({ success: true, whatsapp_link: link, order: { reference: order.reference, status: order.status } });
});

// Lets customers check up front whether their number is already verified
// (fast DataHub delivery) or new (routed through the slower backup path).
app.get('/check-number-status/:phone', async (req, res) => {
  const phone = req.params.phone;
  if (!isValidGhPhone(phone)) return res.json({ success: false, error: 'Invalid phone number' });

  const verifyRes = await datahub.verify('YELLO', phone, true);
  const verified = !!(verifyRes.success && verifyRes.data?.exists);
  const submission = await fb.get(`datahub_verification_submissions/${phone}`);

  res.json({
    success: true,
    isRegistered: verified,
    alreadySubmitted: !!submission,
    message: verified
      ? 'This number is verified — data is delivered within minutes.'
      : 'This is a new number. Buying data now still works — delivery just takes up to 2–3 working days while verification completes.',
  });
});

// Lets a customer proactively submit their number to DataHub's verification
// queue before (or without) buying anything — so it's already in progress by
// the time they do place an order. Purely a head start; purchases for
// unverified numbers work immediately regardless, via the backup provider.
app.post('/submit-for-verification', async (req, res) => {
  const phone = req.body.phone;
  if (!isValidGhPhone(phone)) return res.json({ success: false, error: 'Enter a valid 10-digit phone number starting with 0' });

  const verifyRes = await datahub.verify('YELLO', phone, true);
  if (verifyRes.success && verifyRes.data?.exists) {
    return res.json({ success: true, alreadyVerified: true, message: 'This number is already verified — nothing to submit.' });
  }

  const record = await submitToDataHubInBackground(phone);
  if (!record.submitted) {
    return res.json({ success: false, error: record.response || 'Could not submit this number right now. Please try again later.' });
  }

  res.json({
    success: true,
    alreadySubmitted: true,
    message: 'Submitted for network verification. This typically takes 2–3 working days. You can still buy data on this number right away — it will just be delivered once verification completes.',
  });
});

// ── Admin (you — there's no reseller layer in v1, just one owner) ──

app.post('/admin/login', loginLimiter, (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Unauthorized' });
  res.json({ success: true, token: signAdminToken() });
});

const adminRouter = express.Router();
adminRouter.use(requireAdmin);

adminRouter.get('/dashboard', async (req, res) => {
  const ordersRaw = (await fb.get('orders')) || {};
  const orders = Object.values(ordersRaw).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 200);
  const totalRevenue = orders.filter((o) => o.status === 'SUCCESSFUL').reduce((sum, o) => sum + (o.amount_paid || 0), 0);
  const totalProfit = orders.filter((o) => o.status === 'SUCCESSFUL').reduce((sum, o) => sum + (o.profit || 0), 0);
  res.json({ success: true, orders, total_revenue: totalRevenue, total_profit: totalProfit });
});

adminRouter.get('/prices', async (req, res) => res.json({ success: true, prices: (await fb.get('prices/customer')) || {} }));

adminRouter.post('/prices', async (req, res) => {
  const updates = {};
  req.body.prices.forEach((p) => { updates[`prices/customer/${p.network}/${p.size}`] = { price: p.price, validity: p.validity, capacity: p.capacity }; });
  await db.ref().update(updates);
  res.json({ success: true, message: 'Prices updated' });
});

adminRouter.post('/prices/delete', async (req, res) => {
  await fb.remove(`prices/customer/${req.body.network}/${req.body.size}`);
  res.json({ success: true, message: 'Bundle removed' });
});

adminRouter.post('/order/retry', async (req, res) => {
  const order = await fb.get(`orders/${req.body.order_id}`);
  if (!order) return res.json({ success: false, error: 'Order not found' });
  if (order.status === 'SUCCESSFUL') return res.json({ success: false, error: 'Order already successful' });

  // Retry through whichever provider it was already routed to; if it never
  // got routed at all (e.g. it failed before that point), re-run full routing.
  let result;
  if (order.fulfillment_provider === 'databosshub') result = await attemptDataBossPurchase(order);
  else if (order.fulfillment_provider === 'datahub') result = await attemptDataHubPurchase(order);
  else result = await routeOrder(order);

  res.json({ success: result.status !== 'FAILED', order: result });
});

adminRouter.post('/order/set-status', async (req, res) => {
  const valid = ['PENDING', 'AWAITING_VERIFICATION', 'PROCESSING', 'SUCCESSFUL', 'FAILED', 'MANUAL_REVIEW'];
  if (!valid.includes(req.body.status)) return res.json({ success: false, error: 'Invalid status' });
  const updated = await applyStatusUpdate(req.body.order_id, req.body.status, { manually_set: true });
  res.json({ success: !!updated, order: updated });
});

adminRouter.post('/blocked-numbers/add', async (req, res) => { await fb.set(`blocked_numbers/${req.body.phone}`, true); res.json({ success: true }); });
adminRouter.post('/blocked-numbers/remove', async (req, res) => { await fb.remove(`blocked_numbers/${req.body.phone}`); res.json({ success: true }); });

adminRouter.post('/announcement', async (req, res) => {
  const { title, message, is_active } = req.body;
  if (!message || !message.trim()) return res.json({ success: false, error: 'Message cannot be empty' });
  const existing = await fb.get('announcements/active');
  await fb.set('announcements/active', { title: title || 'Announcement', message: message.trim(), is_active: is_active === true, updated_at: new Date().toISOString(), created_at: existing?.created_at || new Date().toISOString() });
  res.json({ success: true, message: 'Announcement saved' });
});
adminRouter.post('/announcement/clear', async (req, res) => { await fb.remove('announcements/active'); res.json({ success: true, message: 'Announcement removed' }); });

app.use('/admin', adminRouter);

// ── Webhooks ──

app.post('/webhook/datahub-status', (req, res) => {
  // DataHub requires a 2xx within 10s — ack immediately, resolve async.
  res.status(200).json({ received: true });
  handleDatahubWebhook(req.body).catch((err) => console.error('[webhook] datahub handler error:', err.message));
});

const DATAHUB_STATUS_MAP = { SUCCESSFUL: 'SUCCESSFUL', FAILED: 'FAILED', PROCESSING: 'PROCESSING', PENDING: 'PROCESSING', INITIATED: 'PROCESSING', CANCELLED: 'FAILED' };

async function handleDatahubWebhook(body) {
  const { event, data } = body || {};
  if (event !== 'order.status_updated' || !data?.reference) return;
  console.log(`[webhook] datahub event received: ${data.status} for ${data.reference}`);

  let orderKey = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    let [key] = await fb.findOneBy('orders', 'datahub_reference', data.reference);
    if (!key) [key] = await fb.findOneBy('orders', 'reference', data.reference);
    if (key) { orderKey = key; break; }
    await sleep(Math.min(2000 * attempt, 15000));
  }

  if (!orderKey) {
    console.error(`[webhook] order not found for datahub reference ${data.reference} after retries`);
    await fb.push('webhook_dead_letters', { webhook_data: body, received_at: new Date().toISOString(), reference: data.reference, status: 'unprocessed' });
    return;
  }

  const mapped = DATAHUB_STATUS_MAP[(data.status || '').toUpperCase()] || 'PROCESSING';
  await applyStatusUpdate(orderKey, mapped, { datahub_status: data.status, webhook_received_at: new Date().toISOString() });
  console.log(`[webhook] order ${orderKey} -> ${mapped}`);
}

app.post('/webhook/paystack', async (req, res) => {
  const valid = paystack.verifyWebhookSignature(req.body, req.headers['x-paystack-signature']);
  if (!valid) return res.status(401).send('Invalid signature');
  res.status(200).send('ok');

  try {
    const event = JSON.parse(req.body.toString());
    if (event.event === 'charge.success') {
      const reference = event.data.reference;
      const [existingKey] = await fb.findOneBy('orders', 'paystack_reference', reference);
      if (!existingKey) console.log(`[webhook] paystack charge.success for ${reference} — will be picked up by /payment/verify.`);
    }
  } catch (err) { console.error('[webhook] paystack handler error:', err.message); }
});

// ── 404 + error handlers ──
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));
app.use((err, req, res, next) => { console.error('[server] unhandled error:', err); res.status(500).json({ success: false, error: 'Service temporarily unavailable. Please try again.' }); });

// ══════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`Byvox backend (v1) running on port ${PORT}`);
  setInterval(pollDataBossOrders, DATABOSS_POLL_MS);
  console.log(`DataBossHub order poller running every ${DATABOSS_POLL_MS / 1000 / 60} minutes`);
});

if (BACKEND_URL) {
  setInterval(() => { fetch(`${BACKEND_URL}/health`).catch(() => {}); }, 10 * 60 * 1000); // keep free-tier instance warm
}
