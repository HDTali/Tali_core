// Paywall gate — ported from the real n8n nodes "If3" (free-tier gate) and
// "Лимит подписчика?" (monthly cap for active subscribers), text copied
// verbatim from "Send final offer" and "Лимит месяца" (05.08.2026, from a
// fresh export — "ТАЛИ main (5).json" — supplied by Наталия the same day).
//
// Real gate logic (two independent checks, ported as-is, not simplified):
//   status === 'active' (paying subscriber):
//     monthly_used >= 120  -> block, show "Лимит месяца" (renew)
//     else                 -> allow, increment questions_used + monthly_used
//   status !== 'active' (free or expired):
//     questions_used < 5   -> allow, increment questions_used + monthly_used
//     else                 -> block, show "Send final offer" (upsell)
//
// NOT ported yet (separate follow-up, not part of this pass):
//   - "subscription_details" / "natali_services" callback screens — buttons
//     are shown (matching the real message) but tapping them doesn't do
//     anything on our side yet, same as an unbuilt n8n branch would.
//   - "Лимит месяца" for active subscribers renews via "subscription_details"
//     in the real bot (a details screen), not a direct pay link — since that
//     screen isn't built, the button there won't do anything yet either.

const { pool } = require('./db');
const { createSubscriptionInvoice } = require('./wayforpayInvoice');

function t(lang, ru, ua) {
  return lang === 'ua' ? ua : ru;
}

// Returns { allowed: true } and bumps counters, OR { allowed: false } and
// leaves counters untouched — caller is responsible for sending whatever
// paywall message checkGate's sibling below builds.
async function incrementUsage(userId) {
  const { rows } = await pool.query(
    `UPDATE entitlements
       SET questions_used = questions_used + 1,
           monthly_used = monthly_used + 1,
           updated_at = now()
     WHERE user_id = $1 RETURNING *`,
    [userId]
  );
  return rows[0];
}

async function checkGate(userId) {
  const { rows } = await pool.query('SELECT * FROM entitlements WHERE user_id = $1', [userId]);
  const ent = rows[0];
  if (!ent) {
    // Shouldn't happen — resolveIdentity always creates one — but fail closed.
    return { allowed: false, reason: 'no_entitlements' };
  }

  if (ent.status === 'active') {
    if ((ent.monthly_used || 0) >= ent.monthly_limit) {
      return { allowed: false, reason: 'monthly_limit', entitlements: ent };
    }
    return { allowed: true, entitlements: ent };
  }

  // free or expired
  if (ent.questions_used < ent.questions_limit) {
    return { allowed: true, entitlements: ent };
  }
  return { allowed: false, reason: 'free_limit', entitlements: ent };
}

// "Лимит месяца" — active subscriber hit the 120/month cap.
function monthlyLimitMessage(lang) {
  return {
    text: t(
      lang,
      `🤍 Все 120 вопросов этого месяца пройдены — это по-настоящему глубокая работа над собой.\n\nЧтобы продолжить дальше, продли Тали ещё на месяц. Я снова буду рядом — новые 120 вопросов и память о нашем пути.\n\nПродлить? 👇`,
      `🤍 Усі 120 запитань цього місяця пройдені — це справді глибока робота над собою.\n\nЩоб продовжити далі, продовж Талі ще на місяць. Я знову буду поруч — нові 120 запитань і памʼять про наш шлях.\n\nПродовжити? 👇`
    ),
    buttons: [
      [{ text: t(lang, '💛 Продлить за 14,9 €', '💛 Продовжити за 14,9 €'), callback_data: 'subscription_details' }],
    ],
  };
}

// "Send final offer" — free tier's 5 questions exhausted. Needs a live
// invoice link, so this one is async (calls WayForPay), unlike the others.
async function finalOfferMessage(lang, telegramId) {
  const invoiceUrl = await createSubscriptionInvoice(telegramId);
  return {
    text: t(
      lang,
      `🕊 Это был последний из 5 бесплатных вопросов.\n\nЕсли хочешь продолжать разбираться в своей карте — у тебя есть два пути:\n\n<b> 🕊 Тали на месяц · 14,9 EUR</b>\n30 дней я рядом и 120 вопросов ко мне. Ты можешь рассмотреть каждую тему или задавать мне личные вопросы текстом или голосом. Я буду помнить наш разговор и отвечать с точки зрения твоей уникальности.\n\n<b>✨ Консультация с Натали · Нажми услуги.</b>\nЖивая работа в Zoom, 1,5 часа с видеозаписью. Натали соединит детали карты с твоей реальной жизнью и запустит улучшения в разных сферах жизни.\n\nЧто откликается?`,
      `🕊 Це було останнє з 5 безкоштовних запитань.\n\nЯкщо хочеш продовжувати розбиратися у своїй карті — у тебе є два шляхи:\n\n<b> 🕊 Талі на місяць · 14,9 EUR</b>\n30 днів я поруч і 120 питань до мене. Ти можеш розглянути кожну тему або ставити мені особисті запитання текстом чи голосом. Я памʼятатиму нашу розмову і відповідатиму з точки зору твоєї унікальності.\n\n<b>✨ Консультація з Наталі · Натисни послуги.</b>\nЖива робота в Zoom, 1,5 години з відеозаписом. Наталі поєднає деталі карти з твоїм реальним життям і запустить покращення в різних сферах життя.\n\nЩо відгукується?`
    ),
    buttons: [
      [{ text: t(lang, '🕊 Тали на месяц - 14,9 EUR', '🕊 Талі на місяць - 14,9 EUR'), url: invoiceUrl }],
      [{ text: t(lang, '✨ Услуги Натали', '✨ Послуги Наталі'), callback_data: 'natali_services' }],
      [{ text: t(lang, '👀 Расскажи подробнее про подписку.', '👀 Розкажи детальніше про підписку.'), callback_data: 'subscription_details' }],
      [{ text: t(lang, '📣 Телеграм Канал Натали', '📣 Телеграм Канал Наталі'), url: 'https://t.me/hd_popovych' }],
      [{ text: t(lang, '🤍 Поделиться Тали с близкими', '🤍 Поділитися Талі з близькими'), url: 'https://t.me/share/url?url=https://t.me/tali_hd_bot' }],
    ],
  };
}

module.exports = { checkGate, incrementUsage, monthlyLimitMessage, finalOfferMessage };
