// Paid readings from the website, paid through LiqPay. Added 11.11.2026.
//
// Flow: site form -> POST /web/order (checks, saves the order, signs the LiqPay
// payment) -> the visitor pays on LiqPay's own page -> LiqPay calls
// POST /web/liqpay/callback (signature checked) -> order marked paid -> letters
// to the client and to Nataly.
//
// Prices live HERE, on the server: the browser only says which topic and format.
// Ukrainian site pays in UAH (LiqPay requirement); English and Russian in USD.
//
// Keys only in environment variables (Render): LIQPAY_PUBLIC_KEY, LIQPAY_PRIVATE_KEY.
// Test mode is ON unless LIQPAY_LIVE=1 is set (LiqPay "sandbox": no real money).

const crypto = require('crypto');

const SITE_URL = process.env.WEB_SITE_URL || 'https://natalypopovych.com';
const CORE_URL = (process.env.WEB_CORE_URL || 'https://tali-core-identity-billing.onrender.com').replace(/\/$/, '');
const CONTACT_EMAIL = process.env.WEB_CONTACT_EMAIL || 'hello@natalypopovych.com';
const ORDERS_NOTIFY_EMAIL = process.env.WEB_ORDERS_EMAIL || CONTACT_EMAIL;
const CHECKOUT_URL = 'https://www.liqpay.ua/api/3/checkout';
const TELEGRAM_URL = process.env.WEB_TELEGRAM_URL || 'https://t.me/Natalia_Popovych';
const TELEGRAM_CHANNEL_URL = 'https://t.me/hd_popovych';
const INSTAGRAM_URL = 'https://www.instagram.com/popovych_human_design/';
const YOUTUBE_URL = 'https://www.youtube.com/@NewEraHuman';
// WhatsApp Business number: set WEB_WHATSAPP_URL (e.g. https://wa.me/380...) in Render when it's ready.
const WHATSAPP_URL = process.env.WEB_WHATSAPP_URL || '';
// Nataly's Google Calendar booking page (one 90-minute schedule for every live session).
const BOOKING_URL = process.env.WEB_BOOKING_URL || 'https://calendar.app.google/N3zHauoGkG7ZuoSM7';
const POLICY_VERSION = '2026-11-11';

const TOPICS = ['work', 'energy', 'self', 'relationships', 'couple', 'child', 'family'];
const FORMATS = ['pdf', 'audio', 'video'];
const TOGETHER = ['couple', 'family'];
const PEOPLE = {
  work: [1, 1], energy: [1, 1], self: [1, 1], relationships: [1, 1],
  couple: [2, 2], child: [1, 2], family: [2, 5],
};

// Change prices only together with the site (lib/content/*.ts).
const PRICES = {
  personal: { pdf: { USD: 49, UAH: 2250 }, audio: { USD: 99, UAH: 4500 }, video: { USD: 199, UAH: 9050 } },
  together: { pdf: { USD: 99, UAH: 4500 }, audio: { USD: 199, UAH: 9050 }, video: { USD: 299, UAH: 13600 } },
  child: { pdf: { USD: 49, UAH: 2250 }, audio: { USD: 79, UAH: 3600 }, video: { USD: 149, UAH: 6800 } },
};

function currencyFor(lang) {
  return lang === 'uk' ? 'UAH' : 'USD';
}

function priceFor(topic, format, currency) {
  const group = topic === 'child' ? 'child' : TOGETHER.includes(topic) ? 'together' : 'personal';
  return PRICES[group][format][currency];
}

// ---- Names shown in letters and on LiqPay's page ----
const NAMES = {
  topic: {
    uk: { work: 'Робота та гроші', energy: 'Стан та внутрішній ресурс', self: 'Пізнати себе та свій потенціал', relationships: 'Кохання та стосунки', couple: 'Розбір пари', child: 'Зрозуміти свою дитину', family: 'Розбір сім\'ї' },
    ru: { work: 'Работа и деньги', energy: 'Состояние и ресурс', self: 'Понять себя и свой потенциал', relationships: 'Любовь и отношения', couple: 'Разбор пары', child: 'Понять своего ребёнка', family: 'Разбор семьи' },
    en: { work: 'Career & Money', energy: 'Energy & Well-Being', self: 'Self-Discovery & Potential', relationships: 'Love & Relationships', couple: 'Couple Reading', child: 'Understanding Your Child', family: 'Family Dynamics' },
  },
  format: {
    uk: { pdf: 'PDF-розбір', audio: 'Аудіорозбір', video: 'Онлайн-зустріч' },
    ru: { pdf: 'PDF-разбор', audio: 'Аудиоразбор', video: 'Онлайн-встреча' },
    en: { pdf: 'PDF Reading', audio: 'Audio Reading', video: 'Live Session' },
  },
};

const CONSENT_TEXTS = {
  uk: 'Я погоджуюся з Публічною офертою і Політикою конфіденційності.',
  ru: 'Я соглашаюсь с Публичной офертой и Политикой конфиденциальности.',
  en: 'I agree to the Terms and the Privacy Policy.',
};

// ---- Checking what the form sent ----
function cleanText(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanDate(value) {
  const s = String(value || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1900 || dt.getTime() > Date.now()) return null;
  return s;
}

function cleanTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** Returns { order } with clean fields, or { error }. */
function validateOrder(b, cleanEmail) {
  const lang = ['en', 'uk', 'ru'].includes(b.lang) ? b.lang : null;
  if (!lang) return { error: 'bad_order' };
  if (!TOPICS.includes(b.topic) || !FORMATS.includes(b.format)) return { error: 'bad_order' };
  const name = cleanText(b.name, 80);
  if (name.length < 1) return { error: 'bad_name' };
  const email = cleanEmail(b.email);
  if (!email) return { error: 'bad_email' };
  if (b.consent !== true) return { error: 'consent_required' };
  const readingLang = ['en', 'uk', 'ru'].includes(b.readingLang) ? b.readingLang : lang;

  const [min, max] = PEOPLE[b.topic];
  const raw = Array.isArray(b.persons) ? b.persons.slice(0, max) : [];
  const persons = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] || {};
    const optional = b.topic === 'child' && i === 1; // the parent's data is optional
    const date = cleanDate(p.date);
    const place = cleanText(p.place, 120);
    if (optional && !date && !place) continue;
    if (!date) return { error: 'bad_date' };
    const unknownTime = p.unknownTime === true;
    const time = unknownTime ? null : cleanTime(p.time);
    if (!unknownTime && !time) return { error: 'bad_time' };
    if (place.length < 2) return { error: 'bad_place' };
    persons.push({ role: b.topic === 'child' ? (i === 0 ? 'child' : 'parent') : `person${i + 1}`, name: cleanText(p.name, 80), date, time, unknownTime, place });
  }
  if (persons.length < min) return { error: 'bad_date' };

  const situation = cleanText(b.situation, 3000);
  if (b.format === 'audio' && situation.length < 3) return { error: 'situation_required' };
  const questions = (Array.isArray(b.questions) ? b.questions : []).slice(0, 3).map((q) => cleanText(q, 600)).filter(Boolean);
  const note = cleanText(b.note, 2000);
  const messenger = cleanText(b.messenger, 80); // Telegram username or WhatsApp number, optional

  const currency = currencyFor(lang);
  return {
    order: {
      lang, topic: b.topic, format: b.format, name, email, readingLang, currency,
      amount: priceFor(b.topic, b.format, currency),
      details: { persons, situation: situation || null, questions, note: note || null, messenger: messenger || null },
      consentText: CONSENT_TEXTS[lang],
    },
  };
}

// ---- LiqPay ----
function keys() {
  const publicKey = process.env.LIQPAY_PUBLIC_KEY;
  const privateKey = process.env.LIQPAY_PRIVATE_KEY;
  return publicKey && privateKey ? { publicKey, privateKey } : null;
}

function isLive() {
  return process.env.LIQPAY_LIVE === '1';
}

function sign(data, privateKey) {
  return crypto.createHash('sha1').update(privateKey + data + privateKey).digest('base64');
}

/** The two fields LiqPay's checkout page needs: data (base64 JSON) and signature. */
function checkoutFields(order, ref, siteOrigin) {
  const k = keys();
  if (!k) return null;
  const prefix = order.lang === 'en' ? '' : `/${order.lang}`;
  const params = {
    version: 3,
    public_key: k.publicKey,
    action: 'pay',
    amount: order.amount,
    currency: order.currency,
    description: `${NAMES.topic[order.lang][order.topic]} · ${NAMES.format[order.lang][order.format]} · ${ref}`,
    order_id: ref,
    language: order.lang === 'uk' ? 'uk' : 'en',
    result_url: `${siteOrigin}${prefix}/order/thanks/?o=${encodeURIComponent(ref)}`,
    server_url: `${CORE_URL}/web/liqpay/callback`,
  };
  if (!isLive()) params.sandbox = 1;
  const data = Buffer.from(JSON.stringify(params)).toString('base64');
  return { url: CHECKOUT_URL, data, signature: sign(data, k.privateKey), test: !isLive() };
}

/** Checks LiqPay's message. Returns the decoded payment, or null if the signature is wrong. */
function readCallback(data, signature) {
  const k = keys();
  if (!k || typeof data !== 'string' || typeof signature !== 'string') return null;
  const expected = sign(data, k.privateKey);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** LiqPay status word -> our order status (null = leave as it is, payment still in progress). */
function statusFrom(liqpayStatus) {
  if (liqpayStatus === 'success' || liqpayStatus === 'sandbox') return 'paid';
  if (liqpayStatus === 'failure' || liqpayStatus === 'error') return 'failed';
  if (liqpayStatus === 'reversed') return 'refunded';
  return null;
}

function newRef() {
  const d = new Date();
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  let tail = '';
  for (const byte of crypto.randomBytes(4)) tail += alphabet[byte % alphabet.length];
  return `NP-${day}-${tail}`;
}

// ---- Letters ----
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function money(amount, currency) {
  const n = Number(amount);
  return currency === 'UAH' ? `${n.toLocaleString('uk-UA').replace(/ /g, ' ')} ₴` : `$${n.toLocaleString('en-US')}`;
}

const NEXT = {
  uk: {
    pdf: 'PDF-розбір надішлю на цей email протягом 5 днів.',
    audio: 'Аудіорозбір надішлю на цей email протягом 7 днів. Після нього ще 7 днів можна ставити уточнювальні запитання за темою.',
    video: 'Протягом доби я напишу тобі на цей email, щоб узгодити зручний час для зустрічі в Zoom.',
  },
  ru: {
    pdf: 'PDF-разбор пришлю на этот email в течение 5 дней.',
    audio: 'Аудиоразбор пришлю на этот email в течение 7 дней. После него ещё 7 дней можно задавать уточняющие вопросы по теме.',
    video: 'В течение суток я напишу тебе на этот email, чтобы согласовать удобное время для встречи в Zoom.',
  },
  en: {
    pdf: "I'll send your PDF reading to this email within 5 days.",
    audio: "I'll send your audio reading to this email within 7 days. For 7 days after that, you can ask clarifying questions on the same topic.",
    video: "Within a day, I'll email you to agree on a convenient time for our Zoom session.",
  },
};

/** What happens next, as HTML and as plain text. Live sessions get the booking link. */
function nextStep(row) {
  const L = row.lang;
  if (row.format !== 'video') return { html: NEXT[L][row.format], text: NEXT[L][row.format] };
  const a = `<a href="${BOOKING_URL}" style="color:#765B37">`;
  const ref = esc(row.order_ref);
  const book = {
    uk: [`Обери зручний час для зустрічі в Zoom у ${a}моєму календарі</a>. У формі вкажи номер замовлення ${ref}. Посилання на Zoom прийде в листі з підтвердженням.`, 'Обери зручний час для зустрічі в Zoom у моєму календарі'],
    ru: [`Выбери удобное время для встречи в Zoom в ${a}моём календаре</a>. В форме укажи номер заказа ${ref}. Ссылка на Zoom придёт в письме с подтверждением.`, 'Выбери удобное время для встречи в Zoom в моём календаре'],
    en: [`Please choose a convenient time for our Zoom session in ${a}my calendar</a>. In the form, enter your order number ${ref}. The Zoom link will come in the confirmation email.`, 'Please choose a convenient time for our Zoom session in my calendar'],
  }[L];
  const length = row.topic === 'child'
    ? { uk: 'Зустріч триває 1 годину.', ru: 'Встреча длится 1 час.', en: 'The session lasts 1 hour.' }[L]
    : TOGETHER.includes(row.topic)
      ? { uk: 'Зустріч триває 2 години: після бронювання я сама подовжу запис.', ru: 'Встреча длится 2 часа: после бронирования я сама продлю запись.', en: "The session lasts 2 hours: after you book, I'll extend the time myself." }[L]
      : '';
  return {
    html: [book[0], length].filter(Boolean).join(' '),
    text: [`${book[1]}: ${BOOKING_URL} (${row.order_ref}).`, length].filter(Boolean).join(' '),
  };
}

function clientLetter(row) {
  const L = row.lang;
  const what = `${NAMES.topic[L][row.topic]} · ${NAMES.format[L][row.format]} · ${money(row.amount, row.currency)}`;
  const t = {
    uk: { subject: `Замовлення ${row.order_ref} оплачено`, hello: `Вітаю, ${esc(row.client_name)}!`, thanks: `Дякую! Оплата пройшла. Номер твого замовлення: <b>${esc(row.order_ref)}</b>.`, reply: 'Якщо маєш запитання, просто відповідай на цей лист.', bye: 'З теплом,<br>Наталі' },
    ru: { subject: `Заказ ${row.order_ref} оплачен`, hello: `Здравствуй, ${esc(row.client_name)}!`, thanks: `Спасибо! Оплата прошла. Номер твоего заказа: <b>${esc(row.order_ref)}</b>.`, reply: 'Если есть вопросы, просто ответь на это письмо.', bye: 'С теплом,<br>Натали' },
    en: { subject: `Order ${row.order_ref} is paid`, hello: `Hi ${esc(row.client_name)},`, thanks: `Thank you! Your payment went through. Your order number is <b>${esc(row.order_ref)}</b>.`, reply: 'If you have any questions, just reply to this email.', bye: 'With warmth,<br>Nataly' },
  }[L];
  const link = (href, label) => `<a href="${href}" style="color:#765B37">${label}</a>`;
  const chat = {
    uk: `Якщо зручніше в месенджері, пиши мені в ${link(TELEGRAM_URL, 'Telegram')}${WHATSAPP_URL ? ` або ${link(WHATSAPP_URL, 'WhatsApp')}` : ''}.`,
    ru: `Если удобнее в мессенджере, пиши мне в ${link(TELEGRAM_URL, 'Telegram')}${WHATSAPP_URL ? ` или ${link(WHATSAPP_URL, 'WhatsApp')}` : ''}.`,
    en: `If a messenger is easier for you, write to me on ${link(TELEGRAM_URL, 'Telegram')}${WHATSAPP_URL ? ` or ${link(WHATSAPP_URL, 'WhatsApp')}` : ''}.`,
  }[L];
  // Where to follow Nataly. Ukrainian and Russian readers also get Instagram and the Telegram channel.
  const socials = L === 'en'
    ? [['YouTube', YOUTUBE_URL]]
    : [['Instagram', INSTAGRAM_URL], [L === 'uk' ? 'Telegram-канал' : 'Telegram-канал', TELEGRAM_CHANNEL_URL], ['YouTube', YOUTUBE_URL]];
  const follow = { uk: 'Мої соцмережі', ru: 'Мои соцсети', en: 'Follow me' }[L];
  const followHtml = `${follow}: ${socials.map(([n, u]) => link(u, n)).join(' · ')}`;
  const next = nextStep(row);
  const paragraphs = [t.hello, t.thanks, esc(what), next.html, t.reply, chat, followHtml, t.bye];
  const text = [
    t.hello, t.thanks.replace(/<[^>]+>/g, ''), what, next.text, t.reply,
    `${chat.replace(/<[^>]+>/g, '')} ${TELEGRAM_URL}${WHATSAPP_URL ? ` ${WHATSAPP_URL}` : ''}`,
    `${follow}: ${socials.map(([n, u]) => `${n} ${u}`).join(' · ')}`,
    t.bye.replace('<br>', '\n'),
  ].join('\n\n');
  return { subject: t.subject, paragraphs, text };
}

const LANG_RU = { uk: 'украинский', ru: 'русский', en: 'английский' };

function natalyLetter(row) {
  const d = row.details || {};
  const lines = [
    `<b>${esc(row.order_ref)}</b> оплачен${row.liqpay_status === 'sandbox' ? ' (ТЕСТ, без реальных денег)' : ''}`,
    `${esc(NAMES.topic.ru[row.topic])} · ${esc(NAMES.format.ru[row.format])} · ${esc(money(row.amount, row.currency))}`,
    `Клиент: ${esc(row.client_name)}, <a href="mailto:${esc(row.email)}">${esc(row.email)}</a>`,
    ...(d.messenger ? [`Мессенджер для связи: ${esc(d.messenger)}`] : []),
    `Язык сайта: ${LANG_RU[row.lang]} · язык разбора: ${LANG_RU[row.reading_lang] || esc(row.reading_lang)}`,
  ];
  for (const p of d.persons || []) {
    const who = { child: 'Ребёнок', parent: 'Родитель' }[p.role] || 'Человек';
    lines.push(`${who}${p.name ? ` (${esc(p.name)})` : ''}: ${esc(p.date)}, ${p.unknownTime ? 'время неизвестно' : esc(p.time)}, ${esc(p.place)}`);
  }
  if (d.situation) lines.push(`Ситуация: ${esc(d.situation).replace(/\n/g, '<br>')}`);
  (d.questions || []).forEach((q, i) => lines.push(`Вопрос ${i + 1}: ${esc(q)}`));
  if (d.note) lines.push(`Комментарий: ${esc(d.note).replace(/\n/g, '<br>')}`);
  const text = lines.map((l) => l.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')).join('\n\n');
  return {
    subject: `${row.liqpay_status === 'sandbox' ? '[ТЕСТ] ' : ''}Новый заказ ${row.order_ref}: ${NAMES.topic.ru[row.topic]} · ${NAMES.format.ru[row.format]}`,
    paragraphs: lines,
    text,
  };
}

module.exports = {
  POLICY_VERSION,
  ORDERS_NOTIFY_EMAIL,
  SITE_URL,
  validateOrder,
  checkoutFields,
  readCallback,
  statusFrom,
  newRef,
  clientLetter,
  natalyLetter,
  keys,
  _test: { sign, priceFor, currencyFor, cleanDate, cleanTime },
};
