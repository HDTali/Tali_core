// Minimal Telegram Bot API client.
// The real HTML-sanitizing / message-splitting logic (see "разбивка смс" in
// n8n) gets ported here in a later step (task 7); onboarding messages are
// short enough not to need splitting.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function callTelegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`telegram ${method} failed`, res.status, await res.text());
  }
  return res.ok;
}

// options.buttons: array of rows, each row an array of { text, callback_data }
// e.g. [[{ text: '👩 Женский', callback_data: 'gender_female' }], [{ text: '👨 Мужской', callback_data: 'gender_male' }]]
// matches the one-button-per-row layout used by the "Gender" node in n8n.
async function sendMessage(chatId, text, options = {}) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (options.buttons) {
    body.reply_markup = { inline_keyboard: options.buttons };
  }
  return callTelegram('sendMessage', body);
}

async function sendPhoto(chatId, photoUrlOrFileId, caption) {
  const body = { chat_id: chatId, photo: photoUrlOrFileId };
  if (caption) {
    body.caption = caption;
    body.parse_mode = 'HTML';
  }
  return callTelegram('sendPhoto', body);
}

// Telegram shows a loading spinner on an inline button until this is called —
// matches the "Answer Callback Query" node in n8n.
async function answerCallbackQuery(callbackQueryId) {
  return callTelegram('answerCallbackQuery', { callback_query_id: callbackQueryId });
}

module.exports = { sendMessage, sendPhoto, answerCallbackQuery };
