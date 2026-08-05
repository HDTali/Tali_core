// Creates a live WayForPay payment link for the "Тали на месяц" subscription
// — the part of billing n8n still does today (the OTHER half, receiving the
// payment confirmation, already moved to routes/wayforpay.js). Ported
// verbatim from the real invoice-generating nodes ("HTTP Request" in the
// main workflow, "Way for pay code" in the test-people workflow) —
// merchantAccount/productName/amount/currency are copied as-is, not
// reinvented. 05.08.2026.
//
// merchantSignature uses WAYFORPAY_SECRET_KEY — the SAME env var already
// set in Render for verifying inbound callbacks (one secret per merchant
// account, used for both directions). Never hardcode it here — the real
// n8n node has it hardcoded in plain JS, which is exactly the kind of
// exposure findings #1/#2 in the original audit flagged; not repeating that.

const { signInvoiceRequest } = require('./wayforpaySignature');

const MERCHANT_ACCOUNT = 'freelance_user_66d1b8e7d677f';
const MERCHANT_DOMAIN_NAME = 'popovychdesign.app.n8n.cloud'; // kept as-is — this is what's registered with WayForPay for this merchant account, changing it is a WayForPay-dashboard question, not a code one
const AMOUNT = 770;
const CURRENCY = 'UAH';
const PRODUCT_NAME = 'Подписка Тали на месяц';
const PRODUCT_COUNT = 1;
const ORDER_TIMEOUT_SECONDS = 2592000; // 30 days — keeps the link from expiring same-day

// Deliberately points at OUR service, not n8n's — this is new invoice
// generation code, so the payment confirmation for it should land on the
// already-built-and-tested /webhooks/wayforpay here, not on the old n8n
// node. Doesn't affect the LIVE bot today (nothing here is wired to it yet)
// — only matters once this Conversation Service actually goes live.
const SERVICE_URL = 'https://tali-core-identity-billing.onrender.com/webhooks/wayforpay';

async function createSubscriptionInvoice(telegramId) {
  const secretKey = process.env.WAYFORPAY_SECRET_KEY;
  if (!secretKey) {
    throw new Error('WAYFORPAY_SECRET_KEY is not set');
  }

  const orderDate = Math.floor(Date.now() / 1000);
  // Same convention as the real bot: sub_<telegram_id>_<timestamp>, so the
  // existing /webhooks/wayforpay orderReference parsing (routes/wayforpay.js)
  // keeps working unchanged.
  const orderReference = `sub_${telegramId}_${Date.now()}`;

  const merchantSignature = signInvoiceRequest(
    {
      merchantAccount: MERCHANT_ACCOUNT,
      merchantDomainName: MERCHANT_DOMAIN_NAME,
      orderReference,
      orderDate,
      amount: AMOUNT,
      currency: CURRENCY,
      productName: PRODUCT_NAME,
      productCount: PRODUCT_COUNT,
      productPrice: AMOUNT,
    },
    secretKey
  );

  const res = await fetch('https://api.wayforpay.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transactionType: 'CREATE_INVOICE',
      apiVersion: 1,
      merchantAccount: MERCHANT_ACCOUNT,
      merchantDomainName: MERCHANT_DOMAIN_NAME,
      merchantSignature,
      orderReference,
      orderDate,
      orderTimeout: ORDER_TIMEOUT_SECONDS,
      amount: AMOUNT,
      currency: CURRENCY,
      productName: [PRODUCT_NAME],
      productPrice: [AMOUNT],
      productCount: [PRODUCT_COUNT],
      serviceUrl: SERVICE_URL,
    }),
  });

  const json = await res.json();
  if (!res.ok || !json.invoiceUrl) {
    const err = new Error(`WayForPay CREATE_INVOICE failed: ${res.status} ${JSON.stringify(json)}`);
    err.wayforpayResponse = json;
    throw err;
  }
  return json.invoiceUrl;
}

module.exports = { createSubscriptionInvoice };
