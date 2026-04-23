const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is not set');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

// Authoritative pricing — never trust client-supplied prices
const COUNTY_DATA = {
  // Large counties
  'baltimore-co':   { name: 'Baltimore County',       monthly: 77, onetime: 97 },
  'prince-georges': { name: "Prince George's County", monthly: 77, onetime: 97 },
  'montgomery':     { name: 'Montgomery County',      monthly: 77, onetime: 97 },
  // Medium counties
  'anne-arundel':   { name: 'Anne Arundel County',    monthly: 47, onetime: 67 },
  'baltimore-city': { name: 'Baltimore City',          monthly: 47, onetime: 67 },
  'harford':        { name: 'Harford County',          monthly: 47, onetime: 67 },
  'howard':         { name: 'Howard County',           monthly: 47, onetime: 67 },
  'carroll':        { name: 'Carroll County',          monthly: 47, onetime: 67 },
  // Small counties
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

function volumeDiscountRate(count) {
  if (count >= 3) return 0.20;
  if (count === 2) return 0.10;
  return 0;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { items, mode } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided' });
  }

  if (mode !== 'subscription' && mode !== 'payment') {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  const rate      = volumeDiscountRate(items.length);
  const lineItems = [];

  for (const item of items) {
    const county = COUNTY_DATA[item.id];
    if (!county) {
      return res.status(400).json({ error: `Unknown county: ${item.id}` });
    }

    const baseAmount = (mode === 'subscription' ? county.monthly : county.onetime) * 100;
    // Discount applies to subscriptions only; one-time purchases are always full price.
    const discountedAmount = mode === 'subscription'
      ? Math.round(baseAmount * (1 - rate))
      : baseAmount;

    const label = mode === 'subscription' ? 'First Month' : 'One-Time Purchase';
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${county.name} — Maryland Probate Leads (${label})`,
          description: mode === 'subscription'
            ? 'Immediate first-month payment. Recurring subscription set up next.'
            : 'One-time batch of Maryland probate filings.',
        },
        unit_amount: discountedAmount,
      },
      quantity: 1,
    });
  }

  const baseUrl  = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
  const countyIds = items.map(i => i.id).join(',');

  // Subscription: success redirects to subscribe.html to set up the recurring billing.
  // One-time: success goes straight to success.html.
  const successUrl = mode === 'subscription'
    ? `${baseUrl}/subscribe.html?counties=${encodeURIComponent(countyIds)}&session_id={CHECKOUT_SESSION_ID}`
    : `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',   // always payment for step 1
      line_items: lineItems,
      success_url: successUrl,
      cancel_url:  `${baseUrl}/cancel.html`,
      billing_address_collection: 'required',
      consent_collection: {
        terms_of_service: 'required',
      },
      custom_text: {
        terms_of_service_acceptance: {
          message: 'I agree to the [Terms & Conditions](https://monthlyprobatedirect.com/terms). Subscriptions auto-renew monthly until cancelled.',
        },
      },
      metadata: {
        purchase_mode: mode,
        county_ids:    countyIds,
        discount_pct:  String(rate * 100),
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error details:', {
      type:       err.type,
      code:       err.code,
      param:      err.param,
      statusCode: err.statusCode,
      message:    err.message,
    });
    return res.status(500).json({
      error:   'Failed to create checkout session',
      details: err.message,
      code:    err.code  || null,
      type:    err.type  || null,
      param:   err.param || null,
    });
  }
};
