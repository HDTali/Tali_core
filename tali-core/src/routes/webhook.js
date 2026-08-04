const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { resolveIdentity } = require('../identityCore');
const { sendMessage, answerCallbackQuery } = require('../telegramClient');
const { getOrCreateProfile, isOnboardingState, handleOnboarding } = require('../onboarding');

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
    let telegramId, chatId, text, callbackData, callbackQueryId;

    if (update.message && update.message.from) {
      telegramId = update.message.from.id;
      chatId = update.message.chat.id;
      text = update.message.text || '';
    } else if (update.callback_query) {
      telegramId = update.callback_query.from.id;
      chatId = update.callback_query.message.chat.id;
      callbackData = update.callback_query.data;
      callbackQueryId = update.callback_query.id;
      await answerCallbackQuery(callbackQueryId);
    } else {
      return res.status(200).json({ ok: true }); // nothing we handle yet
    }

    const { user_id } = await resolveIdentity('telegram', telegramId);
    const profile = await getOrCreateProfile(user_id);

    if (isOnboardingState(profile.state)) {
      await handleOnboarding({ userId: user_id, chatId, profile, text, callbackData });
      return res.status(200).json({ ok: true });
    }

    // Onboarding is done (state = chart_ready or beyond) — real free-chat /
    // topics / paywall / RAG / Claude logic is tasks 4-7, not built yet.
    // Diagnostic reply only, same as the original skeleton.
    const { rows } = await pool.query('SELECT * FROM entitlements WHERE user_id = $1', [user_id]);
    const entitlements = rows[0] || {};
    await sendMessage(
      chatId,
      `Онбординг пройден (state: ${profile.state}). Свободный чат/темы ещё не перенесены.\n` +
        `Бесплатных использовано: ${entitlements.questions_used}/${entitlements.questions_limit}, в этом месяце: ${entitlements.monthly_used}/${entitlements.monthly_limit}`
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('webhook handling failed', err);
    // Still 200 — Telegram retries aggressively on non-200, and retrying
    // won't fix a bug in our code.
    res.status(200).json({ ok: false });
  }
});

module.exports = router;
