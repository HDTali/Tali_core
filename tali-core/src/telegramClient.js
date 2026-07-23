// Minimal Telegram Bot API client — just enough to send a text reply.
// The real HTML-sanitizing / message-splitting logic (see "разбивка смс" in
// n8n) gets ported here in a later step; the skeleton just needs to prove
// the round trip works end to end.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function sendMessage(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    console.error('telegram sendMessage failed', res.status, await res.text());
  }
  return res.ok;
}

module.exports = { sendMessage };
