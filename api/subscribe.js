const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is not set');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

// Authoritative pricing — never trust client-supplied prices.
const COUNTY_DATA = {
  'baltimore-co':   { name: 'Baltimore County',       monthly: 77, onetime: 97 },
  'prince-georges': { name: "Prince George's County", monthly: 77, onetime: 97 },
  'montgomery':     { name: 'Montgomery County',      monthly: 77, onetime: 97 },
  'anne-arundel':   { name: 'Anne Arundel County',    monthly: 47, onetime: 67 },
  'baltimore-city': { name: 'Baltimore City',          monthly: 47, onetime: 67 },
  'harford':        { name: 'Harford County',          monthly: 47, onetime: 67 },
  'howard':         { name: 'Howard County',           monthly: 47, onetime: 67 },
  'carroll':        { name: 'Carroll County',          monthly: 47, onetime: 67 },
  'allegany':       { name: 'Allegany County',         monthly: 37, onetime: 47 },
  'calvert':        { name: 'Calvert County',          monthly: 37, onetime: 47 },
  'caroline':       { name: 'Caroline County',         monthly: 37, onetime: 47 },
  'cecil':          { name: 'Cecil County',            monthly: 37, onetime: 47 },
  'charles':        { name: 'Charles County',          monthly: 37, onetime: 47 },
  'dorchester':     { name: 'Dorchester County',       monthly: 37, onetime: 47 },
  'garrett':        { name: 'Garrett County',          monthly: 37, onetime: 47 },
  'kent':           { name: 'Kent County',             monthly: 37, onetime: 47 },
  'queen-annes':    { name: "Queen Anne's County",     monthly: 37, onetime: 47 },
  'st-marys':       { name: "St. Mary's County",       monthly: 37, onetime: 47 },
  'somerset':       { name: 'Somerset County',         monthly: 37, onetime: 47 },
  'talbot':         { name: 'Talbot County',           monthly: 37, onetime: 47 },
  'wicomico':       { name: 'Wicomico County',         monthly: 37, onetime: 47 },
  'worcester':      { name: 'Worcester County',        monthly: 37, onetime: 47 },
};

// Volume discount: 10% for 2 counties, 20% for 3+. Applies every month,
// including the first.
function volumeDiscountRate(count) {
  if (count >= 3) return 0.20;
  if (count === 2) return 0.10;
  return 0;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { items, addOns } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided' });
  }

  const rate      = volumeDiscountRate(items.length);
  const lineItems = [];

  // First-month charge — the real discounted amount, shown and charged today.
  for (const item of items) {
    const county = COUNTY_DATA[item.id];
    if (!county) {
      return res.status(400).json({ error: `Unknown county: ${item.id}` });
    }
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${county.name} — Maryland Probate Leads (First Month)`,
          description: 'First month of a monthly subscription. Renews on the 1st of each month.',
        },
        unit_amount: Math.round(county.monthly * 100 * (1 - rate)),
      },
      quantity: 1,
    });
  }

  // Optional one-time archive add-ons (last month's data) — never discounted.
  if (Array.isArray(addOns)) {
    for (const addon of addOns) {
      const county = COUNTY_DATA[addon.id];
      if (!county) {
        return res.status(400).json({ error: `Unknown county for add-on: ${addon.id}` });
      }
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${county.name} — Last Month's Archive (One-Time)`,
            description: "One-time purchase of last month's Maryland probate filings.",
          },
          unit_amount: Math.round(county.onetime * 0.5 * 100),
        },
        quantity: 1,
      });
    }
  }

  const baseUrl   = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
  const countyIds = items.map(i => i.id).join(',');
  const addonIds  = Array.isArray(addOns) ? addOns.map(a => a.id).join(',') : '';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      // Save the card so /api/finalize can set up the recurring subscription.
      payment_intent_data: { setup_future_usage: 'off_session' },
      customer_creation: 'always',
      success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/cancel.html`,
      billing_address_collection: 'required',
      custom_text: {
        submit: {
          message: 'This is your first month. Your subscription renews on the 1st of each month at the same price and can be cancelled anytime.',
        },
      },
      metadata: {
        purchase_mode: 'subscription',
        county_ids:    countyIds,
        addon_ids:     addonIds,
        discount_pct:  String(rate * 100),
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe subscribe error:', {
      type:       err.type,
      code:       err.code,
      param:      err.param,
      statusCode: err.statusCode,
      message:    err.message,
    });
    return res.status(500).json({
      error:   'Failed to create subscription session',
      details: err.message,
      code:    err.code  || null,
      type:    err.type  || null,
      param:   err.param || null,
    });
  }
};
