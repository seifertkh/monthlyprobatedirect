const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is not set');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

// Full monthly prices — no discounts on recurring subscription
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

function firstOfNextMonthUnix() {
  const now = new Date();
  return Math.floor(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided' });
  }

  const lineItems = [];

  for (const item of items) {
    const county = COUNTY_DATA[item.id];
    if (!county) {
      return res.status(400).json({ error: `Unknown county: ${item.id}` });
    }

    lineItems.push({
      price_data: {
        currency: 'usd',
        recurring: { interval: 'month' },
        product_data: {
          name: `${county.name} — Maryland Probate Leads`,
          description: 'Monthly Maryland probate filings, renewing on the 1st',
        },
        unit_amount: county.monthly * 100, // full undiscounted price
      },
      quantity: 1,
    });
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: lineItems,
      success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/cancel.html`,
      billing_address_collection: 'required',
      subscription_data: {
        // Free trial until the 1st of next month — first real charge hits on the 1st
        trial_end: firstOfNextMonthUnix(),
      },
      metadata: {
        county_ids: items.map(i => i.id).join(','),
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
