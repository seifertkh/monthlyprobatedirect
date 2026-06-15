const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is not set');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

// Authoritative pricing — recomputed server-side; never trust the client.
const COUNTY_DATA = {
  'baltimore-co':   { name: 'Baltimore County',       monthly: 77 },
  'prince-georges': { name: "Prince George's County", monthly: 77 },
  'montgomery':     { name: 'Montgomery County',      monthly: 77 },
  'anne-arundel':   { name: 'Anne Arundel County',    monthly: 47 },
  'baltimore-city': { name: 'Baltimore City',          monthly: 47 },
  'harford':        { name: 'Harford County',          monthly: 47 },
  'howard':         { name: 'Howard County',           monthly: 47 },
  'carroll':        { name: 'Carroll County',          monthly: 47 },
  'allegany':       { name: 'Allegany County',         monthly: 37 },
  'calvert':        { name: 'Calvert County',          monthly: 37 },
  'caroline':       { name: 'Caroline County',         monthly: 37 },
  'cecil':          { name: 'Cecil County',            monthly: 37 },
  'charles':        { name: 'Charles County',          monthly: 37 },
  'dorchester':     { name: 'Dorchester County',       monthly: 37 },
  'garrett':        { name: 'Garrett County',          monthly: 37 },
  'kent':           { name: 'Kent County',             monthly: 37 },
  'queen-annes':    { name: "Queen Anne's County",     monthly: 37 },
  'st-marys':       { name: "St. Mary's County",       monthly: 37 },
  'somerset':       { name: 'Somerset County',         monthly: 37 },
  'talbot':         { name: 'Talbot County',           monthly: 37 },
  'wicomico':       { name: 'Wicomico County',         monthly: 37 },
  'worcester':      { name: 'Worcester County',        monthly: 37 },
};

function volumeDiscountRate(count) {
  if (count >= 3) return 0.20;
  if (count === 2) return 0.10;
  return 0;
}

// First of next month at NOON UTC. Noon (not midnight) guarantees the date
// renders as the 1st in US timezones — Stripe shows dates in the account's
// timezone (Eastern), and midnight-UTC would display as the 30th.
function firstOfNextMonthUnix() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 12, 0, 0) / 1000);
}

// Subscription items need an existing product ID (the API rejects inline
// product_data). Look up a per-county product by metadata, creating it once.
// Cached in module memory across warm invocations.
const productCache = {};
async function getCountyProductId(countyId, countyName) {
  if (productCache[countyId]) return productCache[countyId];

  const found = await stripe.products.search({
    query: `active:'true' AND metadata['mpd_county']:'${countyId}'`,
    limit: 1,
  });

  const product = found.data.length > 0
    ? found.data[0]
    : await stripe.products.create({
        name: `${countyName} — Maryland Probate Leads`,
        metadata: { mpd_county: countyId },
      });

  productCache[countyId] = product.id;
  return product.id;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { session_id } = req.body;
  if (!session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['payment_intent'],
    });

    if (session.mode !== 'payment') {
      return res.status(400).json({ error: 'Unexpected session mode' });
    }
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'First-month payment not completed' });
    }

    const customerId = typeof session.customer === 'string'
      ? session.customer
      : (session.customer && session.customer.id);

    const paymentMethodId = session.payment_intent && session.payment_intent.payment_method
      ? (typeof session.payment_intent.payment_method === 'string'
          ? session.payment_intent.payment_method
          : session.payment_intent.payment_method.id)
      : null;

    if (!customerId || !paymentMethodId) {
      return res.status(400).json({ error: 'Missing customer or saved card' });
    }

    // Idempotency — if this customer already has a subscription, we're done.
    const existing = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 1 });
    if (existing.data.length > 0) {
      return res.status(200).json({ ok: true, alreadyDone: true, subscriptionId: existing.data[0].id });
    }

    const countyIds = (session.metadata.county_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (countyIds.length === 0) {
      return res.status(400).json({ error: 'No counties on session' });
    }

    const rate = volumeDiscountRate(countyIds.length);

    // Make the saved card the customer's default for future invoices.
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // Build recurring items at the discounted monthly price.
    const subItems = [];
    for (const id of countyIds) {
      const county = COUNTY_DATA[id];
      if (!county) {
        return res.status(400).json({ error: `Unknown county: ${id}` });
      }
      const productId = await getCountyProductId(id, county.name);
      subItems.push({
        price_data: {
          currency:   'usd',
          product:    productId,
          recurring:  { interval: 'month' },
          unit_amount: Math.round(county.monthly * 100 * (1 - rate)),
        },
        quantity: 1,
      });
    }

    // Create the subscription anchored to the 1st. proration_behavior 'none'
    // means no charge now (the first month was already paid at checkout) and
    // no $0 invoice — the first recurring charge lands on the 1st.
    const subscription = await stripe.subscriptions.create({
      customer:               customerId,
      items:                  subItems,
      default_payment_method: paymentMethodId,
      billing_cycle_anchor:   firstOfNextMonthUnix(),
      proration_behavior:     'none',
      metadata: {
        county_ids:       countyIds.join(','),
        discount_pct:     String(rate * 100),
        checkout_session: session_id,
        first_month_paid: 'yes',
      },
    });

    return res.status(200).json({ ok: true, subscriptionId: subscription.id });
  } catch (err) {
    console.error('Stripe finalize error:', {
      type:       err.type,
      code:       err.code,
      param:      err.param,
      statusCode: err.statusCode,
      message:    err.message,
    });
    return res.status(500).json({
      error:   'Failed to set up subscription',
      details: err.message,
      code:    err.code  || null,
      type:    err.type  || null,
      param:   err.param || null,
    });
  }
};
