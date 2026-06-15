const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is not set');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

// Authoritative pricing — recomputed server-side; never trust the client.
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

function volumeDiscountRate(count) {
  if (count >= 3) return 0.20;
  if (count === 2) return 0.10;
  return 0;
}

// Charges the full first month (plus any one-time archive add-ons) immediately
// on the card saved during the subscription Checkout. Idempotent: re-calling
// for the same subscription is a no-op once the first month is charged.
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
      expand: ['subscription'],
    });

    if (session.mode !== 'subscription' || !session.subscription) {
      return res.status(400).json({ error: 'Session has no subscription' });
    }

    const subscription = typeof session.subscription === 'string'
      ? await stripe.subscriptions.retrieve(session.subscription)
      : session.subscription;

    // Idempotency guard — don't charge the first month twice on reload/retry.
    if (subscription.metadata && subscription.metadata.first_month_charged === 'yes') {
      return res.status(200).json({ ok: true, alreadyCharged: true, subscriptionId: subscription.id });
    }

    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id;

    const paymentMethodId = subscription.default_payment_method
      ? (typeof subscription.default_payment_method === 'string'
          ? subscription.default_payment_method
          : subscription.default_payment_method.id)
      : null;

    const countyIds = (session.metadata.county_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    const addonIds  = (session.metadata.addon_ids  || '').split(',').map(s => s.trim()).filter(Boolean);

    if (countyIds.length === 0) {
      return res.status(400).json({ error: 'No counties on session' });
    }

    const rate = volumeDiscountRate(countyIds.length);

    // First-month line items — full discounted monthly price per county.
    for (const id of countyIds) {
      const county = COUNTY_DATA[id];
      if (!county) {
        return res.status(400).json({ error: `Unknown county: ${id}` });
      }
      await stripe.invoiceItems.create({
        customer: customerId,
        amount:   Math.round(county.monthly * 100 * (1 - rate)),
        currency: 'usd',
        description: `${county.name} — Maryland Probate Leads (First Month)`,
      });
    }

    // Optional one-time archive add-ons (last month's data) — never discounted.
    for (const id of addonIds) {
      const county = COUNTY_DATA[id];
      if (!county) {
        return res.status(400).json({ error: `Unknown county for add-on: ${id}` });
      }
      await stripe.invoiceItems.create({
        customer: customerId,
        amount:   Math.round(county.onetime * 0.5 * 100),
        currency: 'usd',
        description: `${county.name} — Last Month's Archive (One-Time)`,
      });
    }

    // Bundle the pending invoice items into one invoice and charge it now.
    const invoice = await stripe.invoices.create({
      customer:               customerId,
      collection_method:      'charge_automatically',
      default_payment_method: paymentMethodId || undefined,
      // We finalize + pay explicitly below, so don't let Stripe auto-collect
      // (which would race the pay() call and error "invoice already paid").
      auto_advance:           false,
      description:            'First month — Monthly Probate Direct',
      metadata:               { checkout_session: session_id, subscription: subscription.id },
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    const paid = await stripe.invoices.pay(finalized.id, {
      payment_method: paymentMethodId || undefined,
    });

    // Mark the subscription so we never double-charge the first month.
    await stripe.subscriptions.update(subscription.id, {
      metadata: { ...subscription.metadata, first_month_charged: 'yes', first_month_invoice: paid.id },
    });

    return res.status(200).json({
      ok: true,
      subscriptionId: subscription.id,
      invoiceId: paid.id,
      amountPaid: paid.amount_paid,
    });
  } catch (err) {
    console.error('Stripe finalize error:', {
      type:       err.type,
      code:       err.code,
      param:      err.param,
      statusCode: err.statusCode,
      message:    err.message,
    });
    return res.status(500).json({
      error:   'Failed to charge first month',
      details: err.message,
      code:    err.code  || null,
      type:    err.type  || null,
      param:   err.param || null,
    });
  }
};
