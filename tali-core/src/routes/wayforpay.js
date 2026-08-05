const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyCallbackSignature, signResponse } = require('../wayforpaySignature');
const { sendMessage } = require('../telegramClient');
const { getOrCreateProfile } = require('../onboarding');

// "Подписка активирована" — ported verbatim from the real n8n node
// "Send a text message" in the "Way for pay (fixed v2)" workflow, the one
// that fires right after Update record sets subscription_status: active.
// RU confirmed live in the JSON export; UA confirmed from
// "Локализация 6 — вспомогательные воркфлоу (укр+рус).md" (same node,
// documented UA variant). No buttons on this message in the real workflow.
function activationMessage(lang) {
  return lang === 'ua'
    ? `🎉 Підписку активовано!\n\nТепер тобі доступні всі матеріали за твоїм дизайном.\n\nНатискай кнопку «Меню», щоб обрати тему, в яку хочеш зануритися.\n\nА ще пам'ятай — я відповідаю на питання в чат, або можеш надіслати голосове не більше 60 сек. 💜`
    : `🎉 Подписка активирована!\n\nТеперь тебе доступны все материалы по твоему дизайну.\n\nНажимай кнопку «Меню», чтобы выбрать тему, в которую хочешь погрузиться.\n\nА ещё помни — я отвечаю на вопросы в чат или можешь отправить голосовое не более 60 сек. 💜`;
}

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
    console.warn('WayForPay callback rejected: bad signature', payload.orderReference);
    return res.status(400).json({ error: 'invalid signature' });
  }

  // Captured inside the try block below (only set when this is an Approved
  // subscription payment) so we can send the activation message AFTER the
  // transaction commits — never send a "you're subscribed" message before
  // the DB write that actually makes it true has landed.
  let activatedTelegramId = null;
  let activatedUserId = null;

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

    // Same orderReference convention n8n already uses today (see
    // "Code Generate invoice" nodes): sub_<telegram_id>_<timestamp>[_<i>].
    // telegram_id is the second underscore-separated segment. This is safe
    // to trust because orderReference is itself covered by the signature we
    // just verified above — nobody can hand us a forged telegram_id without
    // also knowing the WayForPay secret.
    if (payload.transactionStatus === 'Approved') {
      const segments = String(payload.orderReference || '').split('_');
      const telegramId = segments[1];

      if (segments[0] === 'sub' && telegramId) {
        const identity = await client.query(
          'SELECT user_id FROM identity_links WHERE provider = $1 AND external_id = $2',
          ['telegram', telegramId]
        );

        let userId;
        if (identity.rows.length > 0) {
          userId = identity.rows[0].user_id;
        } else {
          const userRow = await client.query('INSERT INTO users DEFAULT VALUES RETURNING id');
          userId = userRow.rows[0].id;
          await client.query(
            'INSERT INTO identity_links (user_id, provider, external_id) VALUES ($1, $2, $3)',
            [userId, 'telegram', telegramId]
          );
          await client.query('INSERT INTO entitlements (user_id) VALUES ($1)', [userId]);
        }

        // Extends from whichever is later: now, or the current expiry (so
        // renewing before the old period ends doesn't lose the remaining days).
        await client.query(
          `UPDATE entitlements
             SET status = 'active',
                 subscription_expires_at = GREATEST(now(), coalesce(subscription_expires_at, now())) + interval '30 days',
                 updated_at = now()
           WHERE user_id = $1`,
          [userId]
        );

        activatedTelegramId = telegramId;
        activatedUserId = userId;
      } else {
        console.warn('Approved payment with unrecognized orderReference format, entitlements not updated:', payload.orderReference);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('WayForPay callback processing failed', err);
    return res.status(500).json({ error: 'processing failed' });
  } finally {
    client.release();
  }

  // Real bot's "🎉 Подписка активирована!" message — chatId is the same as
  // telegramId here because this is always a private 1-on-1 chat with the
  // bot (same assumption the real n8n node makes). Best-effort: a failure
  // here must not affect the response we owe WayForPay below (it already
  // has its money and the DB write already committed).
  if (activatedTelegramId && activatedUserId) {
    try {
      const profile = await getOrCreateProfile(activatedUserId);
      await sendMessage(activatedTelegramId, activationMessage(profile.lang || 'ru'));
    } catch (err) {
      console.error('failed to send activation message', err);
    }
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
