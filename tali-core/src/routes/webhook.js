const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { resolveIdentity } = require('../identityCore');
const { sendMessage } = require('../telegramClient');

// Telegram echoes back whatever secret_token you set when registering the
// webhook, on this exact header, on every single request. Checking it means
// only Telegram (or someone who has the secret) can trigger this route.
// Left optional on purpose: while we're testing with curl there's no
// registered webhook yet, so there's no secret to check against.
function verifyTelegramSecret(req, res, next) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return next(); // not configured yet — skip during early testing
  const got = req.get('x-telegram-bot-api-secret-token');
  if (got !== expected) return res.status(401).json({ error: 'bad secret token' });
  next();
}

router.post('/telegram', verifyTelegramSecret, async (req, res) => {
  const update = req.body || {};

  try {
    if (update.message && update.message.from) {
      const telegramId = update.message.from.id;
      const chatId = update.message.chat.id;
      const text = update.message.text || '(не текст)';

      const { user_id, created } = await resolveIdentity('telegram', telegramId);
      const { rows } = await pool.query('SELECT * FROM entitlements WHERE user_id = $1', [
        user_id,
      ]);
      const entitlements = rows[0] || {};

      // Diagnostic-only reply for now — proves Telegram -> this route ->
      // identityCore -> Postgres -> Telegram works end to end, all inside
      // the same already-deployed service (no second Render service, no
      // extra $/month — see README for why).
      // Real onboarding/paywall/RAG/Claude logic replaces this in the next steps.
      await sendMessage(
        chatId,
        `Скелет диалога на связи.\n\n` +
          `Твой текст: "${text}"\n` +
          `internal user_id: ${user_id} (${created ? 'новый' : 'уже существовал'})\n` +
          `План: ${entitlements.plan}, бесплатных использовано: ${entitlements.questions_used}/${entitlements.questions_limit}, в этом месяце: ${entitlements.monthly_used}/${entitlements.monthly_limit}`
      );
    } else if (update.callback_query) {
      // Кнопки тем — подключим в шаге "перенести onboarding/RAG".
      console.log('callback_query received, not handled yet:', update.callback_query.data);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('webhook handling failed', err);
    // Still 200 — Telegram retries aggressively on non-200, and retrying
    // won't fix a bug in our code.
    res.status(200).json({ ok: false });
  }
});

module.exports = router;
