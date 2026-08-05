// Minimal Telegram Bot API client.
//
// HTML-sanitizing / message-splitting logic below is a verbatim port of the
// "разбивка смс" / "Code in JavaScript1" node from n8n (see
// 02_Промты и код нод/Code in JavaScript1 (чат — с чистилкой звёздочек).js).
// Originally this was going to wait for task 7 (free chat) on the theory
// that onboarding messages are short — turned out wrong: the chart-summary
// text from Claude (~900 words) routinely blows past Telegram's 4096-char
// limit and 04.08.2026 testing hit exactly that ("Bad Request: message is
// too long"). Porting it now since it's not free-chat-specific anyway —
// every sendMessage call benefits from not silently failing on long text.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAX_CHUNK = 3800; // n8n's number — comfortably under Telegram's 4096 hard cap

function stripMarkdown(t) {
  return t
    .replace(/\*\*\*(.+?)\*\*\*/g, '<b>$1</b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\*/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/`/g, '');
}

// Escapes stray < / > that aren't part of a Telegram-supported HTML tag, so
// Claude accidentally writing e.g. "x < y" doesn't break parse_mode: HTML.
function escapeNonHTML(t) {
  const validTag = /<\/?(b|i|u|s|code|pre|a)(\s[^>]*)?>|<tg-spoiler>|<\/tg-spoiler>/gi;
  let result = '';
  let lastIndex = 0;
  let match;
  const re = new RegExp(validTag.source, 'gi');
  while ((match = re.exec(t)) !== null) {
    result += t.slice(lastIndex, match.index).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    result += match[0];
    lastIndex = match.index + match[0].length;
  }
  result += t.slice(lastIndex).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return result;
}

// Closes any <b>/<i> left dangling open — needed per-chunk too, since
// splitting mid-text can otherwise cut a chunk off inside an open tag.
function fixTags(t) {
  const openB = (t.match(/<b>/gi) || []).length;
  const closeB = (t.match(/<\/b>/gi) || []).length;
  if (openB > closeB) for (let i = 0; i < openB - closeB; i++) t += '</b>';
  const openI = (t.match(/<i>/gi) || []).length;
  const closeI = (t.match(/<\/i>/gi) || []).length;
  if (openI > closeI) for (let i = 0; i < openI - closeI; i++) t += '</i>';
  return t;
}

// Splits on paragraph breaks first (keeps chunks readable), falling back to
// a hard slice for any single paragraph that's itself over MAX_CHUNK (the
// n8n node didn't need this fallback because in practice Claude's paragraphs
// never got that long, but it's a cheap safety net).
function splitIntoChunks(text) {
  const cleaned = fixTags(escapeNonHTML(stripMarkdown(text)));
  const paragraphs = cleaned.split('\n\n');
  const chunks = [];
  let current = '';

  for (const p of paragraphs) {
    const candidate = current ? current + '\n\n' + p : p;
    if (candidate.length > MAX_CHUNK && current) {
      chunks.push(fixTags(current.trim()));
      current = p;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(fixTags(current.trim()));

  const final = [];
  for (const c of chunks) {
    if (c.length <= MAX_CHUNK) {
      final.push(c);
    } else {
      for (let i = 0; i < c.length; i += MAX_CHUNK) {
        final.push(fixTags(c.slice(i, i + MAX_CHUNK)));
      }
    }
  }
  return final.length > 0 ? final : [''];
}

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
//
// Long text is split into multiple Telegram messages (see splitIntoChunks
// above); buttons, if any, are attached only to the last chunk.
async function sendMessage(chatId, text, options = {}) {
  const chunks = splitIntoChunks(text || '');
  let allOk = true;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const body = { chat_id: chatId, text: chunks[i], parse_mode: 'HTML' };
    if (isLast && options.buttons) {
      body.reply_markup = { inline_keyboard: options.buttons };
    }
    const ok = await callTelegram('sendMessage', body);
    allOk = allOk && ok;
  }
  return allOk;
}

async function sendPhoto(chatId, photoUrlOrFileId, caption) {
  const body = { chat_id: chatId, photo: photoUrlOrFileId };
  if (caption) {
    body.caption = caption;
    body.parse_mode = 'HTML';
  }
  return callTelegram('sendPhoto', body);
}

// Sends raw image bytes (a Buffer) as a photo — for cases like the bodygraph
// render, which comes back from tali-bodygraph as bytes, not a hosted URL or
// a Telegram file_id, so the JSON-body sendPhoto() above can't be used.
// Matches n8n's "Send a photo message" node (binaryData: true, no caption).
// Needs multipart/form-data, not JSON — uses the Node 18+ global
// FormData/Blob (same runtime that already gives us global fetch elsewhere).
async function sendPhotoBuffer(chatId, buffer, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'bodygraph.png');
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form, // no content-type header — fetch sets the multipart boundary itself
  });
  if (!res.ok) {
    console.error('telegram sendPhoto (buffer) failed', res.status, await res.text());
  }
  return res.ok;
}

// Matches "Видео приветствие" — a raw sendVideoNote call with a fixed
// file_id. IMPORTANT: Telegram file_ids are scoped to the bot that
// originally received/uploaded the file — the real n8n node hardcodes both
// the live bot's token AND a file_id that was uploaded through that same
// live bot. Copying that exact file_id here would silently fail against our
// test bot (different bot = different file_id namespace), so this reads
// both the token (already have it — TOKEN above) and the file_id from an
// env var, so swapping between the test bot (while building) and the real
// bot (at cutover) is just a config change, not a code change.
async function sendVideoNote(chatId) {
  const fileId = process.env.WELCOME_VIDEO_NOTE_FILE_ID;
  if (!fileId) {
    console.error('sendVideoNote skipped — WELCOME_VIDEO_NOTE_FILE_ID not set');
    return false;
  }
  return callTelegram('sendVideoNote', { chat_id: chatId, video_note: fileId });
}

// Telegram shows a loading spinner on an inline button until this is called —
// matches the "Answer Callback Query" node in n8n.
async function answerCallbackQuery(callbackQueryId) {
  return callTelegram('answerCallbackQuery', { callback_query_id: callbackQueryId });
}

module.exports = { sendMessage, sendPhoto, sendPhotoBuffer, sendVideoNote, answerCallbackQuery };
