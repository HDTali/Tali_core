const express = require('express');
const router = express.Router();
const { resolveIdentity } = require('../identityCore');
const { sendMessage, answerCallbackQuery } = require('../telegramClient');
const { getOrCreateProfile, isOnboardingState, handleOnboarding } = require('../onboarding');
const { checkGate, incrementUsage, monthlyLimitMessage, finalOfferMessage } = require('../paywall');

// Telegram echoes back whatever secret_token you set when registering the
// webhook, on this exact header, on every single request. Checking it means
// only Telegram (or someone who has the secret) can trigger this route.
// Left optional on purpose: while we're testing with curl there's no
// registered webhook yet, so there's no secret to check against.
function verifyTelegramSecret(req, res, next) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return next(); // not configured yet — skip during early testing
  const got = req.get('x-telegram-bot-api-secret-token');
  if (got !== expected) {
    // TEMP DEBUG (04.08.2026, remove once onboarding testing is confirmed
    // working): requests were silently going nowhere and nothing showed up
    // in Render logs, so we couldn't tell if Telegram was even reaching us.
    console.error('[webhook] rejected: bad/missing secret token header, got:', got);
    return res.status(401).json({ error: 'bad secret token' });
  }
  next();
}

router.post('/telegram', verifyTelegramSecret, async (req, res) => {
  const update = req.body || {};
  // TEMP DEBUG (04.08.2026, remove once onboarding testing is confirmed
  // working) — log every incoming update so we can see in Render logs
  // whether Telegram is reaching us at all, and with what.
  console.log('[webhook] incoming update:', JSON.stringify(update));

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
      console.log('[webhook] callback_query branch, callbackData:', callbackData);
      await answerCallbackQuery(callbackQueryId);
      console.log('[webhook] answerCallbackQuery done');
    } else {
      console.log('[webhook] update type not handled, ignoring');
      return res.status(200).json({ ok: true }); // nothing we handle yet
    }

    const { user_id } = await resolveIdentity('telegram', telegramId);
    const profile = await getOrCreateProfile(user_id);
    console.log('[webhook] resolved user_id:', user_id, 'profile.state:', profile.state);

    if (isOnboardingState(profile.state)) {
      await handleOnboarding({ userId: user_id, chatId, profile, text, callbackData });
      console.log('[webhook] handleOnboarding done');
      return res.status(200).json({ ok: true });
    }

    // Onboarding is done (state = chart_ready or beyond).
    const lang = profile.lang || 'ru';

    // 05.08.2026: found live — every button tap (menu navigation, "tell me
    // more about the subscription", etc.) was burning a real question from
    // the paywall counter, same as typing an actual question. That's wrong:
    // browsing screens isn't "asking Tali something". Until topics/RAG (шаг
    // 6) are built with a real notion of "this button click delivers a
    // paid answer", NO callback_query counts towards the limit here — only
    // free-text messages do. Known non-content buttons from the paywall
    // messages get a lightweight stub reply; any other callback_data
    // post-onboarding (nothing exists yet — future topic menus land here)
    // is just acknowledged, not charged.
    if (callbackData) {
      const NON_CONTENT_CALLBACKS = new Set(['subscription_details', 'natali_services']);
      if (NON_CONTENT_CALLBACKS.has(callbackData)) {
        await sendMessage(
          chatId,
          lang === 'ua'
            ? 'Цей розділ ще будується 🕊 Скоро тут буде більше деталей.'
            : 'Этот раздел ещё строится 🕊 Скоро здесь будет больше деталей.'
        );
      } else {
        console.log('[webhook] unhandled post-onboarding callback_data (not charged):', callbackData);
      }
      return res.status(200).json({ ok: true });
    }

    // Paywall gate (шаг 5) is real now; the actual free-chat/topics/RAG/Claude
    // answer (шаг 6-7) isn't built yet, so an allowed message still gets a
    // diagnostic reply instead of a real answer — but the gate itself, the
    // counters, and the upsell/renewal messages are the genuine ported logic.
    const gate = await checkGate(user_id);

    if (!gate.allowed) {
      const offer =
        gate.reason === 'monthly_limit'
          ? monthlyLimitMessage(lang)
          : await finalOfferMessage(lang, telegramId);
      await sendMessage(chatId, offer.text, { buttons: offer.buttons });
      return res.status(200).json({ ok: true });
    }

    const entitlements = await incrementUsage(user_id);
    await sendMessage(
      chatId,
      lang === 'ua'
        ? `Онбординг пройдено (state: ${profile.state}). Вільний чат/теми ще не перенесені.\n` +
          `Безкоштовних використано: ${entitlements.questions_used}/${entitlements.questions_limit}, цього місяця: ${entitlements.monthly_used}/${entitlements.monthly_limit}`
        : `Онбординг пройден (state: ${profile.state}). Свободный чат/темы ещё не перенесены.\n` +
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
