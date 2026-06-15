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

// First of next month as a UNIX timestamp (seconds), in the server's local time.
// Used as the subscription billing_cycle_anchor so renewals always land on the 1st.
function firstOfNextMonthUnix() {
  const now = new Date();
  return Math.floor(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { items, addOns } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided' });
  }

  const rate = volumeDiscountRate(items.length);

  const recurringLineItems = []; // billed every month, anchored to the 1st
  const oneTimeLineItems   = []; // billed once, on the first invoice (today)

  for (const item of items) {
    const county = COUNTY_DATA[item.id];
    if (!county) {
      return res.status(400).json({ error: `Unknown county: ${item.id}` });
    }

    // Discount applies to every month, including the first — so the recurring
    // price and the first-month charge use the same discounted amount.
    const monthlyAmount = Math.round(county.monthly * 100 * (1 - rate));

    // Recurring price — charged on the 1st of each month (billing_cycle_anchor).
    recurringLineItems.push({
      price_data: {
        currency: 'usd',
        recurring: { interval: 'month' },
        product_data: {
          name: `${county.name} — Maryland Probate Leads`,
          description: 'Monthly Maryland probate filings, renewing on the 1st.',
        },
        unit_amount: monthlyAmount,
      },
      quantity: 1,
    });

    // First month — a one-time line item billed immediately at checkout. In
    // subscription mode, one-time line items land on the initial invoice only.
    oneTimeLineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${county.name} — Maryland Probate Leads (First Month)`,
          description: 'Immediate first-month payment. Recurring billing begins on the 1st.',
        },
        unit_amount: monthlyAmount,
      },
      quantity: 1,
    });
  }

  // Optional one-time archive add-ons (last month's data) — never discounted.
  if (Array.isArray(addOns) && addOns.length > 0) {
    for (const addon of addOns) {
      const county = COUNTY_DATA[addon.id];
      if (!county) {
        return res.status(400).json({ error: `Unknown county for add-on: ${addon.id}` });
      }
      oneTimeLineItems.push({
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

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      // Recurring items bill on the anchor; one-time items bill now.
      line_items: [...recurringLineItems, ...oneTimeLineItems],
      success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
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
      subscription_data: {
        // Anchor recurring billing to the 1st of next month. With
        // proration_behavior 'none', the gap from signup to the 1st is free —
        // no $0 invoice and no trial (unlike the old trial_end approach). The
        // first month is collected now via the one-time line items above, so
        // the customer pays a full month today and renews full on the 1st.
        billing_cycle_anchor: firstOfNextMonthUnix(),
        proration_behavior: 'none',
        metadata: {
          county_ids:   countyIds,
          discount_pct: String(rate * 100),
        },
      },
      metadata: {
        purchase_mode: 'subscription',
        county_ids:    countyIds,
        discount_pct:  String(rate * 100),
        addon_ids:     Array.isArray(addOns) ? addOns.map(a => a.id).join(',') : '',
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
