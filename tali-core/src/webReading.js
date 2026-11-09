// "First reading" PDF for the English website (stage 5, 09.11.2026).
//
// Flow for one order (a row in reading_requests):
//   1. The text is assembled from ready texts in content/reading.en.json
//      (type, strategy, authority, profile with both lines, signature,
//      not-self). No AI call, so each PDF costs nothing. Nataly edits the
//      texts in that one file.
//   2. pdfkit lays it out: site colours, Cormorant + Manrope, the bodygraph.
//   3. Resend sends the letter with the PDF attached.
// Orders are processed one at a time in the background; failed ones are
// retried (3 attempts), and nothing is lost if the server restarts.

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { pool } = require('./db');
const { callBodygraph } = require('./chartCalc');
const { typeKey, authorityKey, profileKey } = require('./webKeys');
const LIB = require('../content/reading.en.json');

const SITE_URL = process.env.WEB_SITE_URL || 'https://natalypopovych.com';
const CONTACT_EMAIL = process.env.WEB_CONTACT_EMAIL || 'hello@natalypopovych.com';
const TELEGRAM_URL = 'https://t.me/Natalia_Popovych';
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Consent wording. The site shows exactly these sentences next to the
// checkboxes; the core stores its own copy, so a changed page can't change
// what we record. When the wording changes, bump the version.
// ---------------------------------------------------------------------------
const CONSENT_VERSION = '2026-11-09';
const CONSENT_TEXTS = {
  reading_pdf: 'Send my reading to this email. I agree to the Privacy Policy.',
  news: 'Also send me news about Tali and new readings. I can unsubscribe at any time.',
  tali_waitlist: 'Tell me when Tali speaks English. I agree to the Privacy Policy and can unsubscribe at any time.',
};

// ---------------------------------------------------------------------------
// 1. The reading text, assembled from content/reading.en.json
// ---------------------------------------------------------------------------
function chartFacts(thdData) {
  const c = (thdData && thdData.chart) || {};
  return {
    type: c.type || '',
    strategy: c.strategy || '',
    authority: c.authority || '',
    profile: c.profile || '',
    profileName: c.profileName || '',
    definition: c.definition || '',
    signature: c.signature || '',
    notSelf: c.notSelfTheme || '',
    cross: c.incarnationCross || '',
  };
}

// Returns { opening, sections: [{ title, items: [text | { sub, text }] }], closing }.
// Throws if the chart has a type/authority/profile the library doesn't know,
// so a broken PDF is never sent (the order is marked failed and logged).
function composeReading(facts, name) {
  const tk = typeKey(facts.type);
  let ak = authorityKey(facts.authority);
  if (ak === 'ego' && tk === 'projector') ak = 'ego_projected';
  const pk = profileKey(facts.profile);
  const t = LIB.types[tk];
  const a = LIB.authorities[ak];
  const profileText = LIB.profiles[pk];
  if (!t || !a || !profileText) {
    throw new Error(`reading library has no text for type=${facts.type} authority=${facts.authority} profile=${facts.profile}`);
  }
  const [l1, l2] = pk.split('/');
  const profileName = officialProfileName(facts.profile);
  const line = (n, side) => ({
    sub: `Line ${n}, ${LIB.lines[n].name} (${LIB.lines[n].friendly}): ${LIB.profileLineLabels[side]}`,
    text: LIB.lines[n].text,
  });

  return {
    opening: name ? LIB.opening.withName.replace('{name}', name) : LIB.opening.noName,
    sections: [
      { title: `Your type: ${facts.type}`, items: t.type },
      { title: `How you move through life: ${t.strategyName}`, items: t.strategy },
      { title: `How you make decisions: ${a.name}`, items: a.text },
      {
        title: `Your profile: ${pk}${profileName ? ` ${profileName}` : ''}`,
        items: [profileText, line(l1, 'conscious'), line(l2, 'unconscious')],
      },
      { title: `When things feel aligned: ${t.signatureName}`, items: [t.signature] },
      { title: `When things feel out of balance: ${t.notSelfName}`, items: [t.notSelf] },
    ],
    closingTitle: LIB.closingTitle,
    closing: LIB.closing,
  };
}

// Official Human Design profile name, built from the line names in the
// library (e.g. "2/5" -> "Hermit / Heretic"). Our friendly names appear only in the line explanations.
function officialProfileName(profile) {
  const pk = profileKey(profile);
  if (!pk) return '';
  return pk
    .split('/')
    .map((n) => (LIB.lines[n] ? LIB.lines[n].name : n))
    .join(' / ');
}

// ---------------------------------------------------------------------------
// 2. The PDF (pdfkit)
// ---------------------------------------------------------------------------
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const C = {
  page: '#F7F2EA',
  ink: '#2A2559', // indigo, main text
  soft: '#5C567F', // secondary text
  gold: '#D3A04C',
  bronze: '#765B37',
  panel: '#EFE7DA',
  line: '#D9C8AE',
};

function formatBirthDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d} ${months[m - 1]} ${y}`;
}

function renderPdf({ name, birth, placeLabel, facts, reading, bodygraphPng }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 60, bottom: 64, left: 62, right: 62 },
      bufferPages: true,
      info: { Title: 'Your first Human Design reading', Author: 'Nataly Popovych' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('serif', path.join(FONT_DIR, 'CormorantGaramond-Medium.ttf'));
    doc.registerFont('serif-bold', path.join(FONT_DIR, 'CormorantGaramond-SemiBold.ttf'));
    doc.registerFont('serif-italic', path.join(FONT_DIR, 'CormorantGaramond-MediumItalic.ttf'));
    doc.registerFont('sans', path.join(FONT_DIR, 'Manrope-Regular.ttf'));
    doc.registerFont('sans-semi', path.join(FONT_DIR, 'Manrope-SemiBold.ttf'));
    doc.registerFont('sans-bold', path.join(FONT_DIR, 'Manrope-Bold.ttf'));

    const W = doc.page.width;
    const H = doc.page.height;
    const L = doc.page.margins.left;
    const CW = W - L - doc.page.margins.right; // content width
    const paintBackground = () => doc.save().rect(0, 0, W, H).fill(C.page).restore();
    paintBackground();
    doc.on('pageAdded', paintBackground);

    const ensureSpace = (needed) => {
      if (doc.y + needed > H - doc.page.margins.bottom) doc.addPage();
    };
    const goldRule = (y, width = 46) => {
      doc.save().moveTo(L, y).lineTo(L + width, y).lineWidth(1.2).strokeColor(C.gold).stroke().restore();
    };
    const body = (text, opts = {}) => {
      doc.font('sans').fontSize(10.5).fillColor(C.ink).text(text, L, doc.y, { width: CW, lineGap: 3.6, align: 'left', ...opts });
      doc.moveDown(0.75);
    };

    // ---- Page 1: title, bodygraph and the summary table ----
    doc.font('sans-semi').fontSize(8).fillColor(C.bronze)
      .text('NATALY POPOVYCH  ·  HUMAN DESIGN', L, 60, { characterSpacing: 2.2 });
    doc.font('serif-bold').fontSize(36).fillColor(C.ink).text('Your first reading', L, 86);
    const forLine = [
      name ? `Prepared for ${name}` : null,
      `born ${formatBirthDate(birth.date)} at ${birth.time}, ${placeLabel}`,
    ].filter(Boolean).join(', ');
    doc.font('sans').fontSize(10).fillColor(C.soft).text(forLine.charAt(0).toUpperCase() + forLine.slice(1), L, doc.y + 4, { width: CW });
    goldRule(doc.y + 14);

    const topY = doc.y + 32;
    const imgW = 232;
    let imgBottom = topY;
    if (bodygraphPng) {
      doc.image(bodygraphPng, L - 6, topY, { width: imgW });
      imgBottom = topY + imgW * (2104 / 1875);
    }

    const tableX = L + imgW + 22;
    const tableW = CW - imgW - 22;
    const rows = [
      ['Type', facts.type],
      ['Strategy', facts.strategy],
      ['Inner authority', facts.authority],
      ['Profile', `${facts.profile}  ${officialProfileName(facts.profile)}`.trim()],
      ['Definition', facts.definition],
      ['Signature', facts.signature],
      ['Not-self theme', facts.notSelf],
      ['Incarnation cross', facts.cross],
    ].filter((r) => r[1]);
    let ty = topY + 6;
    for (const [label, value] of rows) {
      doc.font('sans-semi').fontSize(7).fillColor(C.bronze).text(label.toUpperCase(), tableX, ty, { width: tableW, characterSpacing: 1.4 });
      doc.font('serif-bold').fontSize(14.5).fillColor(C.ink).text(value, tableX, doc.y + 2, { width: tableW, lineGap: 0 });
      ty = doc.y + 9;
      doc.save().moveTo(tableX, ty - 4.5).lineTo(tableX + tableW, ty - 4.5).lineWidth(0.5).strokeColor(C.line).stroke().restore();
    }

    doc.y = Math.max(imgBottom, ty) + 18;
    doc.font('serif-italic').fontSize(15).fillColor(C.ink).text(reading.opening, L, doc.y, { width: CW, lineGap: 2.5 });
    doc.moveDown(1.2);

    // ---- The sections ----
    for (const section of reading.sections) {
      ensureSpace(150);
      doc.font('serif-bold').fontSize(21).fillColor(C.ink).text(section.title, L, doc.y, { width: CW });
      goldRule(doc.y + 5);
      doc.y += 16;
      for (const item of section.items) {
        if (typeof item === 'string') {
          ensureSpace(60);
          body(item);
        } else {
          // A small sub-heading (used for the two lines of the profile).
          ensureSpace(90);
          doc.font('sans-semi').fontSize(10.5).fillColor(C.bronze).text(item.sub, L, doc.y, { width: CW });
          doc.y += 4;
          body(item.text);
        }
      }
      doc.moveDown(0.6);
    }

    ensureSpace(160);
    if (reading.closingTitle) {
      doc.font('serif-bold').fontSize(21).fillColor(C.ink).text(reading.closingTitle, L, doc.y, { width: CW });
      goldRule(doc.y + 5);
      doc.y += 16;
    }
    for (const para of String(reading.closing).split(/\n\n/)) {
      ensureSpace(40);
      doc.font('serif-italic').fontSize(15).fillColor(C.ink).text(para, L, doc.y, { width: CW, lineGap: 2.5 });
      doc.moveDown(0.6);
    }
    doc.moveDown(0.8);

    // ---- Go deeper ----
    const offers = [
      ['Personal Readings', 'Explore your career, well-being, relationships, or personal potential.'],
      ['Love & Family', "Explore relationship dynamics, your child's individuality, and family connections."],
      ['Personal Mentoring', 'A three-month journey of reflection, personal guidance, and meaningful change.'],
    ];
    const boxPad = 22;
    const innerW = CW - boxPad * 2;
    doc.font('sans').fontSize(10);
    let boxH = boxPad * 2 + 36 + 16; // title + links line
    for (const [, text] of offers) boxH += 15 + doc.heightOfString(text, { width: innerW, lineGap: 3 }) + 12;
    ensureSpace(boxH);
    const boxY = doc.y;
    doc.save().roundedRect(L, boxY, CW, boxH, 10).fill(C.panel).restore();
    doc.save().roundedRect(L, boxY, CW, boxH, 10).lineWidth(0.8).strokeColor(C.gold).stroke().restore();
    doc.font('serif-bold').fontSize(24).fillColor(C.ink).text('Go deeper', L + boxPad, boxY + boxPad, { width: innerW });
    doc.y += 6;
    for (const [title, text] of offers) {
      doc.font('sans-bold').fontSize(10).fillColor(C.ink).text(title, L + boxPad, doc.y, { width: innerW });
      doc.font('sans').fontSize(10).fillColor(C.soft).text(text, L + boxPad, doc.y + 2, { width: innerW, lineGap: 3 });
      doc.y += 12;
    }
    doc.font('sans-semi').fontSize(10).fillColor(C.bronze);
    const linksY = doc.y + 2;
    const siteLabel = SITE_URL.replace(/^https?:\/\//, '');
    doc.text('Explore personal readings', L + boxPad, linksY, { link: `${SITE_URL}/#readings`, underline: false, continued: true })
      .fillColor(C.soft).text('   ·   ', { continued: true })
      .fillColor(C.bronze).text('Telegram', { link: TELEGRAM_URL, continued: true })
      .fillColor(C.soft).text('   ·   ', { continued: true })
      .fillColor(C.bronze).text(CONTACT_EMAIL, { link: `mailto:${CONTACT_EMAIL}` });
    doc.y = boxY + boxH + 14;

    // Tali: a small, separate note, clearly marked as coming soon.
    doc.font('sans-semi').fontSize(9).fillColor(C.bronze).text('COMING SOON', L, doc.y, { characterSpacing: 1.4, continued: true })
      .font('sans').fillColor(C.soft)
      .text('   Tali, a personal AI companion for your chart. Waitlist: ', { characterSpacing: 0, continued: true })
      .fillColor(C.bronze).text(siteLabel, { link: `${SITE_URL}/#tali` });
    doc.y += 14;

    doc.font('sans').fontSize(8).fillColor(C.soft).text(
      'Human Design is a tool for self-knowledge. It does not replace medical, psychological, legal or financial advice.',
      L, doc.y, { width: CW }
    );

    // ---- Footer on every page ----
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // writing inside the margin must not open a new page
      doc.font('sans').fontSize(7.5).fillColor(C.bronze)
        .text(`${siteLabel}   ·   ${i + 1} / ${range.count}`, L, H - 38, { width: CW, align: 'center', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// 3. Email (Resend)
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function letterHtml(paragraphs) {
  const ps = paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#2A2559">${p}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#F7F2EA;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:36px 24px">
<p style="margin:0 0 24px;font-size:11px;letter-spacing:3px;color:#765B37">NATALY POPOVYCH · HUMAN DESIGN</p>
${ps}
<p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#5C567F">${escapeHtml(SITE_URL.replace(/^https?:\/\//, ''))}</p>
</div></body></html>`;
}

async function sendEmail({ to, subject, paragraphs, text, attachments }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // Local testing without an email service: keep the PDF in a folder instead.
    const dir = process.env.WEB_MAIL_DEV_DIR;
    if (!dir) throw new Error('email_not_configured (RESEND_API_KEY is empty)');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    fs.writeFileSync(path.join(dir, `${stamp}-letter.html`), letterHtml(paragraphs));
    for (const a of attachments || []) fs.writeFileSync(path.join(dir, `${stamp}-${a.filename}`), a.content);
    console.log(`[web/mail] DEV: letter to ${to} saved in ${dir}`);
    return `dev-${stamp}`;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || `Nataly Popovych <${CONTACT_EMAIL}>`,
      to: [to],
      reply_to: process.env.MAIL_REPLY_TO || CONTACT_EMAIL,
      subject,
      html: letterHtml(paragraphs),
      text,
      attachments: (attachments || []).map((a) => ({ filename: a.filename, content: a.content.toString('base64') })),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json.id || null;
}

function readingLetter(name) {
  // Copy from the English website brief (09.11.2026). No free-call offer here on purpose.
  const hello = name ? `Hi ${escapeHtml(name)},` : 'Hello,';
  const lines = [
    'Your first Human Design reading is here.',
    "Inside, you'll find a new perspective on your natural strengths, decision-making style, and the patterns that make you unique.",
    'Take your time exploring it. Notice what feels familiar, what surprises you, and what questions come up along the way.',
    "And if there's something in your life you'd like to understand more deeply, I'd be happy to explore it with you.",
  ];
  const paragraphs = [
    hello,
    ...lines,
    `You can find my personal readings here:<br><a href="${SITE_URL}/#readings" style="color:#765B37">${escapeHtml(SITE_URL.replace(/^https?:\/\//, ''))}/#readings</a>`,
    'With warmth,<br>Nataly',
    `<span style="font-size:12px;color:#5C567F">You receive this email because you asked for your reading on ${escapeHtml(SITE_URL.replace(/^https?:\/\//, ''))}.</span>`,
  ];
  const text =
    `${name ? `Hi ${name},` : 'Hello,'}\n\n` +
    lines.join('\n\n') +
    `\n\nYou can find my personal readings here:\n${SITE_URL}/#readings\n\n` +
    'With warmth,\nNataly';
  return { subject: 'Your Human Design reading is here', paragraphs, text };
}

function waitlistLetter() {
  return {
    subject: "You're on the Tali waitlist",
    paragraphs: [
      'Hello,',
      'Thank you for joining the waitlist.',
      "Tali is a personal AI companion I'm creating to help you explore your Human Design chart, ask questions, and discover new perspectives at your own pace.",
      "I'll write to you when the English version is available.",
      'With warmth,<br>Nataly',
      `<span style="font-size:12px;color:#5C567F">You receive this email because you joined the Tali waitlist on ${escapeHtml(SITE_URL.replace(/^https?:\/\//, ''))}. To leave the list, reply with "unsubscribe".</span>`,
    ],
    text:
      "Hello,\n\nThank you for joining the waitlist.\n\nTali is a personal AI companion I'm creating to help you explore your Human Design chart, ask questions, and discover new perspectives at your own pace.\n\nI'll write to you when the English version is available.\n\nWith warmth,\nNataly\n\nTo leave the list, reply with \"unsubscribe\".",
  };
}

// ---------------------------------------------------------------------------
// 4. The background queue
// ---------------------------------------------------------------------------
async function processReading(requestId) {
  const claimed = await pool.query(
    `UPDATE reading_requests SET status = 'processing', attempts = attempts + 1
     WHERE id = $1 AND status = 'queued' AND attempts < $2
     RETURNING id, web_chart_id, email, display_name, attempts`,
    [requestId, MAX_ATTEMPTS]
  );
  if (!claimed.rows.length) return; // already taken, done, or out of attempts
  const rr = claimed.rows[0];

  try {
    const chartRow = await pool.query(
      'SELECT birth_date, birth_time, birth_location, thd_data FROM web_charts WHERE id = $1',
      [rr.web_chart_id]
    );
    if (!chartRow.rows.length) throw new Error('chart not found');
    const wc = chartRow.rows[0];
    const facts = chartFacts(wc.thd_data);

    const reading = composeReading(facts, rr.display_name);

    let bodygraphPng = null;
    try {
      bodygraphPng = await callBodygraph(wc.thd_data, { theme: 'site' });
    } catch (err) {
      console.error('[web/reading] bodygraph failed, PDF without picture:', err.message);
    }

    const bi = (wc.thd_data && wc.thd_data.birthInfo) || {};
    const pdf = await renderPdf({
      name: rr.display_name,
      birth: { date: wc.birth_date, time: wc.birth_time },
      placeLabel: bi.resolvedCity || wc.birth_location,
      facts,
      reading,
      bodygraphPng,
    });

    const letter = readingLetter(rr.display_name);
    const messageId = await sendEmail({
      to: rr.email,
      ...letter,
      attachments: [{ filename: 'Human-Design-first-reading.pdf', content: pdf }],
    });

    await pool.query(
      `UPDATE reading_requests SET status = 'sent', sent_at = now(), email_message_id = $2, last_error = NULL WHERE id = $1`,
      [rr.id, messageId]
    );
    console.log(`[web/reading] sent ${rr.id}`);
  } catch (err) {
    const finalFail = rr.attempts >= MAX_ATTEMPTS;
    console.error(`[web/reading] ${rr.id} attempt ${rr.attempts} failed:`, err.message);
    await pool.query(
      `UPDATE reading_requests SET status = $2, last_error = $3 WHERE id = $1`,
      [rr.id, finalFail ? 'failed' : 'queued', String(err.message).slice(0, 500)]
    );
    if (!finalFail) setTimeout(() => enqueue(rr.id), 2 * 60 * 1000 * rr.attempts).unref();
  }
}

// One order at a time: keeps memory low on the small Render instance.
let chain = Promise.resolve();
function enqueue(requestId) {
  chain = chain.then(() => processReading(requestId)).catch((err) => console.error('[web/reading] queue error:', err));
  return chain;
}

// Picks up orders left behind by a restart, and does the daily GDPR cleanup.
async function sweep() {
  try {
    await pool.query(
      `UPDATE reading_requests SET status = 'queued'
       WHERE status = 'processing' AND created_at < now() - interval '15 minutes'`
    );
    const waiting = await pool.query(
      `SELECT id FROM reading_requests
       WHERE status = 'queued' AND attempts < $1 AND created_at < now() - interval '1 minute'
       ORDER BY created_at LIMIT 20`,
      [MAX_ATTEMPTS]
    );
    for (const r of waiting.rows) enqueue(r.id);
  } catch (err) {
    console.error('[web/reading] sweep failed:', err.message);
  }
}

let lastCleanup = 0;
async function cleanupOldCharts() {
  if (Date.now() - lastCleanup < 23 * 60 * 60 * 1000) return;
  lastCleanup = Date.now();
  try {
    // Anonymous charts nobody ordered a PDF for are kept 30 days only.
    const r = await pool.query(
      `DELETE FROM web_charts w
       WHERE w.created_at < now() - interval '30 days'
         AND NOT EXISTS (SELECT 1 FROM reading_requests r WHERE r.web_chart_id = w.id)`
    );
    if (r.rowCount) console.log(`[web/cleanup] removed ${r.rowCount} old anonymous charts`);
  } catch (err) {
    console.error('[web/cleanup] failed:', err.message);
  }
}

function startBackgroundJobs() {
  setTimeout(() => {
    sweep();
    cleanupOldCharts();
  }, 20 * 1000).unref();
  setInterval(() => {
    sweep();
    cleanupOldCharts();
  }, 5 * 60 * 1000).unref();
}

module.exports = {
  CONSENT_VERSION,
  CONSENT_TEXTS,
  enqueue,
  startBackgroundJobs,
  sendEmail,
  waitlistLetter,
  chartFacts,
  _test: { renderPdf, composeReading, readingLetter },
};
