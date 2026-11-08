// Routes for the English website (Next.js on Netlify). Added 08.11.2026.
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
const DAILY_THD_LIMIT = Number(process.env.WEB_DAILY_THD_LIMIT || 300);
const NEW_CHARTS_PER_IP_PER_HOUR = Number(process.env.WEB_NEW_CHARTS_PER_IP_PER_HOUR || 8);
const REQUESTS_PER_IP_PER_HOUR = Number(process.env.WEB_REQUESTS_PER_IP_PER_HOUR || 60);

// ---- CORS (only the website's own address) ----
router.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = origin && ALLOWED_ORIGINS.includes(origin);
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
function typeKey(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('manifesting')) return 'manifesting_generator';
  if (t.includes('generator')) return 'generator';
  if (t.includes('manifestor')) return 'manifestor';
  if (t.includes('projector')) return 'projector';
  if (t.includes('reflector')) return 'reflector';
  return null;
}

function authorityKey(authority) {
  const a = String(authority || '').toLowerCase();
  if (a.includes('emotion') || a.includes('solar')) return 'emotional';
  if (a.includes('sacral')) return 'sacral';
  if (a.includes('splen')) return 'splenic';
  if (a.includes('self')) return 'self_projected';
  if (a.includes('ego') || a.includes('heart')) return 'ego';
  if (a.includes('lunar') || a.includes('moon')) return 'lunar';
  if (a.includes('mental') || a.includes('environment') || a.includes('sounding') || a.includes('none'))
    return 'mental';
  return null;
}

function profileKey(profile) {
  const m = /(\d)\s*\/\s*(\d)/.exec(String(profile || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

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

module.exports = router;
module.exports._test = { cleanInput, typeKey, authorityKey, profileKey, publicChart };
