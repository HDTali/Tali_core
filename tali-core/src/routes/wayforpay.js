const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyCallbackSignature, signResponse } = require('../wayforpaySignature');

// This endpoint is meant to replace the "Way for pay" n8n webhook node.
// Fixes audit findings #0 (no signature check at all) and #3 (secret
// hardcoded in the workflow) in one move: the secret lives in an env var here,
// and every callback is verified before anything is written.
router.post('/', async (req, res) => {
  const payload = req.body || {};
  const secretKey = process.env.WAYFORPAY_SECRET_KEY;

  if (!secretKey) {
    console.error('WAYFORPAY_SECRET_KEY is not set');
    return res.status(500).json({ error: 'server misconfigured' });
  }

  if (!verifyCallbackSignature(payload, secretKey)) {
    // TEMP DEBUG (remove once signature matching is confirmed): dump the
    // exact payload WayForPay sent so we can see real field values/formats
    // instead of guessing.
    console.warn('WayForPay callback rejected: bad signature', payload.orderReference);
    console.warn('TEMP DEBUG raw payload:', JSON.stringify(payload));
    return res.status(400).json({ error: 'invalid signature' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO payments (order_reference, amount, currency, status, raw_payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_reference) DO UPDATE
         SET status = EXCLUDED.status, raw_payload = EXCLUDED.raw_payload`,
      [payload.orderReference, payload.amount, payload.currency, payload.transactionStatus, payload]
    );

    // TODO (next slice): on transactionStatus === 'Approved', resolve the
    // paying user via orderReference -> user_id and extend entitlements
    // (subscription_expires_at, plan, status). Needs orderReference to encode
    // or map back to a telegram_id/user_id at invoice-creation time — decide
    // that convention when the invoice-issuing side of WayForPay moves here.

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('WayForPay callback processing failed', err);
    return res.status(500).json({ error: 'processing failed' });
  } finally {
    client.release();
  }

  const time = Math.floor(Date.now() / 1000);
  const signature = signResponse(payload.orderReference, 'accept', time, secretKey);

  return res.json({
    orderReference: payload.orderReference,
    status: 'accept',
    time,
    signature,
  });
});

module.exports = router;
