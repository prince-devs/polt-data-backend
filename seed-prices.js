// Seeds starting bundle prices into Firebase so the site has something to
// sell on day one. Edit the BUNDLES list below to match what you actually
// offer, then run:
//
//   npm run seed-prices
//
// Safe to re-run any time you want to update prices — it just overwrites
// the same paths with new values.

require('dotenv').config();
const admin = require('firebase-admin');

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

// network keys must match what /prices and /payment/* expect:
//   mtn        → purchased as YELLO / mtn_xpress
//   telecel    → purchased as TELECEL
//   AT_PREMIUM → purchased as AT_PREMIUM (AirtelTigo iShare)
//   AT_BIGTIME → purchased as AT_BIGTIME (AirtelTigo Bigtime)
//
// `size` is the bundle's key (also what gets sent to DataHub as `capacity`),
// so keep it as the plain GB number as a string, e.g. "1", "2", "5", "10".

// ⚠️ PRICING NOTE — MTN specifically:
// Every MTN order silently routes to whichever provider can fulfill it (see
// server.js routeOrder): DataHub for verified numbers (cheaper), DataBossHub's
// "MTN Unverified" product for unverified ones (pricier, ~4.40–43.00 GHS
// depending on size at time of writing). The customer sees ONE price either
// way, so MTN prices below are set with enough margin to stay profitable even
// in the worst case (DataBossHub fulfilling it) — don't price MTN bundles
// against DataHub's cheaper cost alone, or every silently-routed DataBossHub
// order quietly loses money. Telecel/AirtelTigo aren't affected — they only
// ever use DataHub, so no dual-provider margin concern there.

const BUNDLES = [
  // network       size   price(GHS)  capacityLabel  validity
  ['mtn',        '1',   7.00,  '1GB',  '30 days'],   // DataBossHub cost ≈4.40
  ['mtn',        '2',   13.00, '2GB',  '30 days'],   // DataBossHub cost ≈8.70
  ['mtn',        '5',   28.50, '5GB',  '30 days'],   // DataBossHub cost ≈22.50
  ['mtn',        '10',  52.00, '10GB', '30 days'],   // DataBossHub cost ≈43.00

  ['telecel',    '1',   5.50,  '1GB',  '30 days'],
  ['telecel',    '5',   24.50, '5GB',  '30 days'],
  ['telecel',    '10',  46.00, '10GB', '30 days'],

  ['AT_PREMIUM', '1',   5.00,  '1GB',  '30 days'],
  ['AT_PREMIUM', '5',   23.00, '5GB',  '30 days'],
  ['AT_PREMIUM', '10',  43.00, '10GB', '30 days'],

  ['AT_BIGTIME', '5',   22.00, '5GB',  '30 days'],
  ['AT_BIGTIME', '10',  41.00, '10GB', '30 days'],
];

async function seed() {
  const updates = {};
  for (const [network, size, price, capacity, validity] of BUNDLES) {
    updates[`prices/customer/${network}/${size}`] = { price, capacity, validity };
  }
  await db.ref().update(updates);
  console.log(`Seeded ${BUNDLES.length} bundles into prices/customer.`);
  process.exit(0);
}

seed().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
