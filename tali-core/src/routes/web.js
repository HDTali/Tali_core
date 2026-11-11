// Routes for the English website (Next.js on Cloudflare Pages). Added 08.11.2026.
// Only NEW routes live here, under /web/... — Telegram, WayForPay and
// entitlements routes are not touched.
//
// POST /web/chart — birth date, time and place -> chart keys + bodygraph PNG.
//   No email, no account: the result is anonymous and cached in web_charts.
//
// Protection, because every new chart costs a THD API call:
//   - CORS: browsers may call this only from WEB_ALLOWED_ORIGINS (the site).
//   - Per-IP limits (in memory): a few NEW charts per hour per person.
//   - Daily fuse: at most WEB_DAILY_THD_LIMIT new THD calls per 24 hours.
//   - Cache: the same birth data never goes to THD twice.

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { translateCity, callThdApi, callBodygraph } = require('../chartCalc');

const router = express.Router();

const ALLOWED_ORIGINS = (process.env.WEB_ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.natalia-site-f18\.pages\.dev$/;
const DAILY_THD_LIMIT = Number(process.env.WEB_DAILY_THD_LIMIT || 300);
const NEW_CHARTS_PER_IP_PER_HOUR = Number(process.env.WEB_NEW_CHARTS_PER_IP_PER_HOUR || 8);
const REQUESTS_PER_IP_PER_HOUR = Number(process.env.WEB_REQUESTS_PER_IP_PER_HOUR || 60);

// ---- CORS (only the website's own address) ----
router.use((req, res, next) => {
  const origin = req.headers.origin;
  // Also the site's own preview copies on Cloudflare Pages (e.g. redesign.natalia-site-f18.pages.dev).
  const allowed = origin && (ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_RE.test(origin));
  if (allowed) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(allowed ? 204 : 403);
  if (origin && !allowed) return res.status(403).json({ error: 'origin_not_allowed' });
  next();
});

// ---- Simple in-memory rate limiting per IP ----
const hits = new Map(); // key -> array of timestamps
const HOUR = 60 * 60 * 1000;

function clientIp(req) {
  // Render puts the visitor's address at the END of X-Forwarded-For;
  // earlier values could be faked by the visitor, so the last one is used.
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || 'unknown';
}

function overLimit(key, limit) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < HOUR);
  if (list.length >= limit) {
    hits.set(key, list);
    return true;
  }
  list.push(now);
  hits.set(key, list);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, list] of hits) {
    const fresh = list.filter((t) => now - t < HOUR);
    if (fresh.length) hits.set(key, fresh);
    else hits.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---- Input checks ----
function cleanInput(body) {
  const date = String((body && body.date) || '').trim();
  const time = String((body && body.time) || '').trim();
  const place = String((body && body.place) || '')
    .replace(/[\u0000-\u001f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dm) return { error: 'bad_date' };
  const [y, m, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return { error: 'bad_date' };
  if (y < 1900 || check.getTime() > Date.now()) return { error: 'bad_date' };

  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) return { error: 'bad_time' };

  if (place.length < 2 || place.length > 120) return { error: 'bad_place' };

  return {
    date,
    time: `${tm[1].padStart(2, '0')}:${tm[2]}`,
    place,
  };
}

// ---- Turning THD wording into simple keys the site's texts use ----
const { typeKey, authorityKey, profileKey } = require('../webKeys');

function publicChart(thdData) {
  const c = (thdData && thdData.chart) || {};
  const centers = (thdData && thdData.centers) || {};
  const channels = (thdData && Array.isArray(thdData.channels) && thdData.channels) || [];
  return {
    centersDefined: Array.isArray(centers.defined) ? centers.defined : [],
    centersOpen: Array.isArray(centers.open) ? centers.open : [],
    channels: channels.map((ch) => ({ id: ch.id || ch.gates || null, name: ch.name || null })),
    type: c.type || null,
    strategy: c.strategy || null,
    authority: c.authority || null,
    profile: c.profile || null,
    profileName: c.profileName || null,
    definition: c.definition || null,
    signature: c.signature || null,
    notSelf: c.notSelfTheme || null,
    cross: c.incarnationCross || null,
    keys: {
      type: typeKey(c.type),
      authority: authorityKey(c.authority),
      profile: profileKey(c.profile),
    },
  };
}

// ---- GET /web/places?q=Par — city suggestions with country ----
// Uses Photon (photon.komoot.io), a free open city search built on OpenStreetMap.
// Only the typed letters are sent there — no birth data, nothing personal.
const PLACES_PER_IP_PER_HOUR = Number(process.env.WEB_PLACES_PER_IP_PER_HOUR || 300);
const placeCache = new Map(); // query -> { at, items }
const PLACE_RANK = { city: 0, town: 1, village: 2, hamlet: 3 };

router.get('/places', async (req, res) => {
  const ip = clientIp(req);
  if (overLimit(`places:${ip}`, PLACES_PER_IP_PER_HOUR)) {
    return res.status(429).json({ error: 'too_many_requests' });
  }
  const q = String(req.query.q || '')
    .replace(/[\u0000-\u001f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (q.length < 2) return res.json({ items: [] });

  const key = q.toLowerCase();
  const hit = placeCache.get(key);
  if (hit && Date.now() - hit.at < 24 * HOUR) return res.json({ items: hit.items });

  try {
    const url =
      'https://photon.komoot.io/api/?' +
      new URLSearchParams({ q, limit: '12', lang: 'en' }).toString() +
      '&osm_tag=place:city&osm_tag=place:town&osm_tag=place:village';
    const r = await fetch(url, {
      headers: { 'User-Agent': 'NatalyPopovych-HumanDesign-site/1.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`photon ${r.status}`);
    const data = await r.json();

    const seen = new Set();
    const items = (data.features || [])
      .map((f) => f.properties || {})
      .filter((p) => p.name && p.country)
      .sort((a, b) => (PLACE_RANK[a.osm_value] ?? 9) - (PLACE_RANK[b.osm_value] ?? 9))
      .map((p) => {
        const region = p.state && p.state !== p.name ? p.state : null;
        // What THD receives: "City, Country", or "City, Region, Country" in the US
        // and a few big countries where one name exists in several regions.
        const withRegion = ['US', 'CA', 'AU', 'BR', 'MX', 'IN', 'RU'].includes(p.countrycode);
        const value = [p.name, withRegion ? region : null, p.country].filter(Boolean).join(', ');
        const label = [p.name, region, p.country].filter(Boolean).join(', ');
        return { label, value };
      })
      .filter((it) => (seen.has(it.label) ? false : seen.add(it.label)))
      .slice(0, 7);

    if (placeCache.size > 2000) placeCache.clear();
    placeCache.set(key, { at: Date.now(), items });
    return res.json({ items });
  } catch (err) {
    console.error('[web/places] failed:', err.message);
    // The form still works without suggestions — people can type the city themselves.
    return res.json({ items: [] });
  }
});

// ---- POST /web/chart ----
// ---- Counter of bodygraphs built on the site (11.11.2026) ----
// One row per day (Kyiv time) and site language. Never blocks the answer: if the table
// is missing or the database is slow, the chart is still returned and the error is logged.
function countChart(lang, isNew) {
  const l = ['en', 'uk', 'ru'].includes(lang) ? lang : 'en';
  pool
    .query(
      `INSERT INTO web_chart_stats (day, lang, new_charts, repeat_views)
       VALUES ((now() AT TIME ZONE 'Europe/Kyiv')::date, $1, $2, $3)
       ON CONFLICT (day, lang) DO UPDATE SET
         new_charts = web_chart_stats.new_charts + EXCLUDED.new_charts,
         repeat_views = web_chart_stats.repeat_views + EXCLUDED.repeat_views`,
      [l, isNew ? 1 : 0, isNew ? 0 : 1]
    )
    .catch((err) => console.error('[web/stats] count failed:', err.message));
}

router.post('/chart', async (req, res) => {
  const ip = clientIp(req);
  if (overLimit(`req:${ip}`, REQUESTS_PER_IP_PER_HOUR)) {
    return res.status(429).json({ error: 'too_many_requests' });
  }

  const input = cleanInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  const normPlace = input.place.toLowerCase();
  const inputHash = crypto
    .createHash('sha256')
    .update(`${input.date}|${input.time}|${normPlace}`)
    .digest('hex');

  try {
    let row;
    const cached = await pool.query(
      `UPDATE web_charts SET hits = hits + 1, last_used_at = now()
       WHERE input_hash = $1 RETURNING id, thd_data`,
      [inputHash]
    );

    const isNew = !cached.rows.length;
    if (cached.rows.length) {
      row = cached.rows[0];
    } else {
      if (overLimit(`new:${ip}`, NEW_CHARTS_PER_IP_PER_HOUR)) {
        return res.status(429).json({ error: 'too_many_new_charts' });
      }
      const today = await pool.query(
        `SELECT count(*)::int AS n FROM web_charts WHERE created_at > now() - interval '24 hours'`
      );
      if (today.rows[0].n >= DAILY_THD_LIMIT) {
        console.warn('[web/chart] daily THD fuse reached:', today.rows[0].n);
        return res.status(503).json({ error: 'busy_try_later' });
      }

      const [y, m, d] = input.date.split('-');
      let thd;
      try {
        thd = await callThdApi(`${d}.${m}.${y}`, input.time, translateCity(input.place));
      } catch (err) {
        console.error('[web/chart] THD failed:', err.message, JSON.stringify(err.thdResponse || {}));
        return res.status(422).json({ error: 'place_not_found' });
      }
      const thdData = thd && thd.data;
      if (!thdData || !thdData.chart) {
        console.error('[web/chart] THD returned no chart:', JSON.stringify(thd).slice(0, 500));
        return res.status(422).json({ error: 'place_not_found' });
      }

      const inserted = await pool.query(
        `INSERT INTO web_charts (input_hash, birth_date, birth_time, birth_location, thd_data)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (input_hash) DO UPDATE SET hits = web_charts.hits + 1, last_used_at = now()
         RETURNING id, thd_data`,
        [inputHash, input.date, input.time, input.place, JSON.stringify(thdData)]
      );
      row = inserted.rows[0];
    }

    let bodygraph = null;
    try {
      const png = await callBodygraph(row.thd_data, { theme: 'site' });
      bodygraph = `data:image/png;base64,${png.toString('base64')}`;
    } catch (err) {
      // The chart is still useful without the picture — the site shows a gentle note.
      console.error('[web/chart] bodygraph failed:', err.message);
    }

    countChart(req.body && req.body.lang, isNew);

    // How THD understood the place — shown on the site so people can spot a wrong city.
    const bi = (row.thd_data && row.thd_data.birthInfo) || {};
    return res.json({
      chartId: row.id,
      birth: input,
      place: {
        city: bi.resolvedCity || null,
        timezone: bi.timezone || null,
        coordinates: bi.coordinates || null,
      },
      chart: publicChart(row.thd_data),
      bodygraph,
    });
  } catch (err) {
    console.error('[web/chart] failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ===========================================================================
// Stage 5 (09.11.2026): PDF reading by email + Tali waitlist.
// ===========================================================================
const { resolveIdentity } = require('../identityCore');
const { buildChartCompact } = require('../chartCalc');
const webReading = require('../webReading');

webReading.startBackgroundJobs();

const MAIL_FORMS_PER_IP_PER_HOUR = Number(process.env.WEB_MAIL_FORMS_PER_IP_PER_HOUR || 6);
const READINGS_PER_EMAIL_PER_DAY = Number(process.env.WEB_READINGS_PER_EMAIL_PER_DAY || 3);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(email) ? email : null;
}

function cleanName(value) {
  const name = String(value || '')
    .replace(/[^\p{L}\p{M}' .-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return name || null;
}

async function saveConsent(email, purpose, lang = 'en') {
  await pool.query(
    'INSERT INTO consents (email, purpose, policy_version, consent_text) VALUES ($1, $2, $3, $4)',
    [email, purpose, webReading.CONSENT_VERSION, webReading.consentText(purpose, lang)]
  );
}

// ---- POST /web/reading-email — "send my first reading as a PDF" ----
// Body: { chartId, email, name?, consent: true, news?: boolean, lang?: 'en'|'uk'|'ru', website?: '' (bot trap) }
// Answers at once; Claude + PDF + email happen in the background (about a minute).
router.post('/reading-email', async (req, res) => {
  const ip = clientIp(req);
  if (overLimit(`mail:${ip}`, MAIL_FORMS_PER_IP_PER_HOUR)) {
    return res.status(429).json({ error: 'too_many_requests' });
  }
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // hidden field filled in: a bot, quietly ignored

  const email = cleanEmail(b.email);
  if (!email) return res.status(400).json({ error: 'bad_email' });
  if (b.consent !== true) return res.status(400).json({ error: 'consent_required' });
  const chartId = String(b.chartId || '');
  if (!UUID_RE.test(chartId)) return res.status(400).json({ error: 'bad_chart' });
  const name = cleanName(b.name);
  const lang = webReading.cleanLang(b.lang);

  try {
    const chart = await pool.query(
      'SELECT id, birth_date, birth_time, birth_location, thd_data FROM web_charts WHERE id = $1',
      [chartId]
    );
    if (!chart.rows.length) return res.status(404).json({ error: 'chart_not_found' });
    const wc = chart.rows[0];

    const recent = await pool.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE web_chart_id = $2 AND status <> 'failed')::int AS same
       FROM reading_requests WHERE email = $1 AND created_at > now() - interval '24 hours'`,
      [email, chartId]
    );
    if (recent.rows[0].same > 0) return res.json({ ok: true, already: true }); // double click / resend
    if (recent.rows[0].n >= READINGS_PER_EMAIL_PER_DAY) {
      return res.status(429).json({ error: 'too_many_for_email' });
    }

    await saveConsent(email, 'reading_pdf', lang);
    if (b.news === true) await saveConsent(email, 'news', lang);

    // Same people table as the Telegram bot (provider 'email'), so a future
    // web version of Tali recognises this person. The profile is created only
    // once and never overwritten here.
    let userId = null;
    try {
      userId = (await resolveIdentity('email', email)).user_id;
      const [y, m, d] = wc.birth_date.split('-');
      await pool.query(
        `INSERT INTO profiles (user_id, state, display_name, birth_date, birth_time, birth_location, lang,
                               chart_data, chart_data_full, chart_compact)
         VALUES ($1, 'chart_ready', $2, $3, $4, $5, $9, $6, $7, $8)
         ON CONFLICT (user_id) DO NOTHING`,
        [
          userId,
          name,
          `${d}.${m}.${y}`,
          wc.birth_time,
          wc.birth_location,
          JSON.stringify(wc.thd_data.chart || {}),
          JSON.stringify(wc.thd_data),
          JSON.stringify(buildChartCompact(wc.thd_data)),
          lang === 'uk' ? 'ua' : lang, // the Telegram bot's own codes: 'ua', 'ru'
        ]
      );
    } catch (err) {
      // Not needed for the letter itself — log and carry on.
      console.error('[web/reading-email] identity/profile step failed:', err.message);
    }

    const inserted = await pool.query(
      `INSERT INTO reading_requests (web_chart_id, user_id, email, display_name, lang)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [chartId, userId, email, name, lang]
    );
    webReading.enqueue(inserted.rows[0].id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[web/reading-email] failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---- POST /web/waitlist — "tell me when Tali speaks English" ----
// Body: { email, consent: true, website?: '' }
router.post('/waitlist', async (req, res) => {
  const ip = clientIp(req);
  if (overLimit(`mail:${ip}`, MAIL_FORMS_PER_IP_PER_HOUR)) {
    return res.status(429).json({ error: 'too_many_requests' });
  }
  const b = req.body || {};
  if (b.website) return res.json({ ok: true });
  const email = cleanEmail(b.email);
  if (!email) return res.status(400).json({ error: 'bad_email' });
  if (b.consent !== true) return res.status(400).json({ error: 'consent_required' });

  try {
    await saveConsent(email, 'tali_waitlist');
    const r = await pool.query(
      `INSERT INTO waitlist (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET unsubscribed_at = NULL
       RETURNING (xmax = 0) AS is_new`,
      [email]
    );
    if (r.rows[0].is_new) {
      // A short "you're on the list" letter; the answer to the site doesn't wait for it.
      webReading
        .sendEmail({ to: email, ...webReading.waitlistLetter() })
        .catch((err) => console.error('[web/waitlist] confirmation email failed:', err.message));
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[web/waitlist] failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ===========================================================================
// Paid readings through LiqPay (11.11.2026). See src/webOrders.js.
// ===========================================================================
const webOrders = require('../webOrders');

const ORDERS_PER_IP_PER_HOUR = Number(process.env.WEB_ORDERS_PER_IP_PER_HOUR || 10);
const REF_RE = /^NP-\d{8}-[A-Z2-9]{4}$/;

// ---- POST /web/order — the order form. Saves the order and returns what LiqPay's page needs. ----
router.post('/order', async (req, res) => {
  const ip = clientIp(req);
  if (overLimit(`order:${ip}`, ORDERS_PER_IP_PER_HOUR)) {
    return res.status(429).json({ error: 'too_many_requests' });
  }
  const b = req.body || {};
  if (b.website) return res.status(400).json({ error: 'bad_order' }); // bot trap
  if (!webOrders.keys()) return res.status(503).json({ error: 'payments_not_configured' });

  const checked = webOrders.validateOrder(b, cleanEmail);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const o = checked.order;

  // Where to send the person back after paying: the same site they came from.
  const origin = req.headers.origin;
  const siteOrigin = origin && (ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_RE.test(origin)) ? origin : webOrders.SITE_URL;

  try {
    let ref = null;
    for (let attempt = 0; attempt < 5 && !ref; attempt++) {
      const candidate = webOrders.newRef();
      const r = await pool.query(
        `INSERT INTO orders (order_ref, lang, topic, format, amount, currency, client_name, email, reading_lang,
                             details, consent_text, policy_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (order_ref) DO NOTHING RETURNING order_ref`,
        [candidate, o.lang, o.topic, o.format, o.amount, o.currency, o.name, o.email, o.readingLang,
          JSON.stringify(o.details), o.consentText, webOrders.POLICY_VERSION]
      );
      if (r.rows.length) ref = r.rows[0].order_ref;
    }
    if (!ref) throw new Error('could not create a unique order number');

    const checkout = webOrders.checkoutFields(o, ref, siteOrigin);
    return res.json({ orderRef: ref, amount: o.amount, currency: o.currency, checkout });
  } catch (err) {
    console.error('[web/order] failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---- GET /web/order-status?ref=NP-... — for the thank-you page. No personal data. ----
router.get('/order-status', async (req, res) => {
  const ref = String(req.query.ref || '');
  if (!REF_RE.test(ref)) return res.status(400).json({ error: 'bad_ref' });
  try {
    const r = await pool.query('SELECT status, topic, format FROM orders WHERE order_ref = $1', [ref]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('[web/order-status] failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---- POST /web/liqpay/callback — LiqPay tells us about a payment (server to server). ----
// Form fields: data (base64 JSON), signature. Nothing is trusted until the signature is checked.
router.post('/liqpay/callback', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
  const payment = webOrders.readCallback(req.body && req.body.data, req.body && req.body.signature);
  if (!payment) {
    console.warn('[web/liqpay] callback with a wrong signature ignored');
    return res.status(400).send('bad signature');
  }
  const ref = String(payment.order_id || '');
  try {
    const found = await pool.query('SELECT * FROM orders WHERE order_ref = $1', [ref]);
    if (!found.rows.length) {
      console.warn('[web/liqpay] unknown order', ref);
      return res.status(200).send('ok');
    }
    const order = found.rows[0];
    let next = webOrders.statusFrom(payment.status);
    // A payment counts only if the sum and currency are exactly what we asked for.
    if (next === 'paid' && (Number(payment.amount) !== Number(order.amount) || payment.currency !== order.currency)) {
      console.error('[web/liqpay] amount mismatch', ref, payment.amount, payment.currency);
      next = null;
    }
    const updated = await pool.query(
      `UPDATE orders SET liqpay_status = $2, liqpay_payment_id = $3, liqpay_data = $4,
              status = COALESCE($5, status),
              paid_at = CASE WHEN $5 = 'paid' AND paid_at IS NULL THEN now() ELSE paid_at END
       WHERE order_ref = $1 RETURNING *`,
      [ref, String(payment.status || ''), payment.payment_id ? String(payment.payment_id) : null, JSON.stringify(payment), next]
    );
    const row = updated.rows[0];

    // Payment stuck "in progress" (first message about it) or failed: tell Nataly so she can contact the person.
    const notice = !next && !order.liqpay_status ? 'pending' : row.status === 'failed' && order.status !== 'failed' ? 'failed' : null;
    if (notice) {
      webReading
        .sendEmail({ to: webOrders.ORDERS_NOTIFY_EMAIL, ...webOrders.natalyNotice(row, notice) })
        .catch((err) => console.error('[web/liqpay] notice failed:', ref, err.message));
    }

    if (row.status === 'paid' && !row.emails_sent_at) {
      // Claim the letters first, so a repeated callback never sends them twice.
      const claim = await pool.query(
        'UPDATE orders SET emails_sent_at = now() WHERE order_ref = $1 AND emails_sent_at IS NULL RETURNING order_ref',
        [ref]
      );
      if (claim.rows.length) {
        const toClient = webOrders.clientLetter(row);
        const toNataly = webOrders.natalyLetter(row);
        webReading.sendEmail({ to: row.email, ...toClient }).catch((err) => console.error('[web/liqpay] client letter failed:', ref, err.message));
        webReading.sendEmail({ to: webOrders.ORDERS_NOTIFY_EMAIL, ...toNataly }).catch((err) => console.error('[web/liqpay] Nataly letter failed:', ref, err.message));
      }
    }
    return res.status(200).send('ok');
  } catch (err) {
    console.error('[web/liqpay] callback failed:', err);
    return res.status(500).send('error');
  }
});

// ---- GET /web/stats?key=... — Nataly's private numbers (11.11.2026) ----
// The key lives only in Render (WEB_STATS_KEY). Without it the page does not exist (404).
function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

router.get('/stats', async (req, res) => {
  const key = process.env.WEB_STATS_KEY;
  if (!key || key.length < 12 || !sameSecret(req.query.key || '', key)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  const q = async (sql) => {
    try {
      return (await pool.query(sql)).rows;
    } catch (err) {
      console.error('[web/stats]', err.message);
      return null;
    }
  };
  const today = "(now() AT TIME ZONE 'Europe/Kyiv')::date";
  const totals = await q(`SELECT
      coalesce(sum(new_charts + repeat_views), 0)::int AS all_views,
      coalesce(sum(new_charts), 0)::int AS all_new,
      coalesce(sum(new_charts + repeat_views) FILTER (WHERE day = ${today}), 0)::int AS today,
      coalesce(sum(new_charts + repeat_views) FILTER (WHERE day > ${today} - 7), 0)::int AS week,
      coalesce(sum(new_charts + repeat_views) FILTER (WHERE day > ${today} - 30), 0)::int AS month,
      min(day) AS since
    FROM web_chart_stats`);
  const byLang = await q(`SELECT lang, sum(new_charts + repeat_views)::int AS n, sum(new_charts)::int AS new
    FROM web_chart_stats GROUP BY lang ORDER BY n DESC`);
  const byDay = await q(`SELECT to_char(day, 'DD.MM.YYYY') AS day,
      sum(new_charts + repeat_views)::int AS n, sum(new_charts)::int AS new
    FROM web_chart_stats WHERE day > ${today} - 30 GROUP BY day ORDER BY day DESC`);
  const stored = await q(`SELECT count(*)::int AS charts, coalesce(sum(hits), 0)::int AS hits, min(created_at) AS first FROM web_charts`);
  const pdfs = await q(`SELECT lang, count(*)::int AS n, count(*) FILTER (WHERE status = 'sent')::int AS sent
    FROM reading_requests GROUP BY lang ORDER BY n DESC`);
  const orders = await q(`SELECT status, count(*)::int AS n FROM orders GROUP BY status ORDER BY n DESC`);

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LANG = { en: 'EN', uk: 'UA', ru: 'RU', old: 'до 11.11 (язык не записывался)' };
  const ORDER = { paid: 'оплачено', created: 'не оплачено (ушли со страницы оплаты)', failed: 'ошибка оплаты', refunded: 'возврат' };
  const fmt = (d) => (d ? new Date(d).toLocaleDateString('ru-RU', { timeZone: 'Europe/Kyiv' }) : '');
  const t = (totals && totals[0]) || {};
  const s = (stored && stored[0]) || {};
  const rows = (list, cells) => (list || []).map((r) => `<tr>${cells(r).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Статистика сайта</title>
<style>body{margin:0;background:#F7F2EA;color:#2A2559;font:16px/1.5 Helvetica,Arial,sans-serif}main{max-width:640px;margin:0 auto;padding:24px 16px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}.muted{color:#5C567F;font-size:14px}
.big{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-top:16px}.big div{background:#EFE7DA;border-radius:12px;padding:12px}
.big b{display:block;font-size:28px}table{width:100%;border-collapse:collapse;font-size:15px}td{padding:6px 4px;border-bottom:1px solid #D9C8AE}</style></head>
<body><main><h1>Бодиграфы на сайте</h1>
<p class="muted">Подсчёт идёт с ${esc(fmt(t.since) || 'сегодняшнего дня')}. «Построено» = каждый раз, когда сайт показал бодиграф; «новых» = карты, которых ещё не было в базе.</p>
${totals ? `<div class="big"><div><b>${t.all_views}</b>построено всего</div><div><b>${t.all_new}</b>новых карт</div><div><b>${t.today}</b>сегодня</div><div><b>${t.week}</b>за 7 дней</div><div><b>${t.month}</b>за 30 дней</div></div>` : '<p>Таблица счётчика ещё не создана (нужен SQL).</p>'}
<h2>По языкам</h2><table>${rows(byLang, (r) => [LANG[r.lang] || r.lang, `${r.n} построено`, `${r.new} новых`])}</table>
<h2>По дням (30 дней)</h2><table>${rows(byDay, (r) => [r.day, `${r.n} построено`, `${r.new} новых`])}</table>
<h2>До начала подсчёта</h2><p class="muted">Сейчас в базе ${esc(s.charts)} карт, их открывали ${esc(s.hits)} раз (самая ранняя от ${esc(fmt(s.first))}). Анонимные карты удаляются через 30 дней, поэтому это не вся история.</p>
<h2>Бесплатный PDF</h2><table>${rows(pdfs, (r) => [LANG[r.lang] || r.lang, `${r.n} запросов`, `${r.sent} отправлено`])}</table>
<h2>Заказы</h2><table>${rows(orders, (r) => [ORDER[r.status] || r.status, r.n])}</table>
</main></body></html>`;
  res.type('html').send(html);
});

module.exports = router;
module.exports._test ={ cleanInput, typeKey, authorityKey, profileKey, publicChart, cleanEmail, cleanName };
