const { Pool } = require('pg');

// Render Postgres requires SSL for external/internal connections in most plans;
// rejectUnauthorized:false avoids self-signed cert failures without needing a CA bundle.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
});

// Without this, a single dropped idle connection (network blip, Render
// restarting something on their end — nothing we did wrong) crashes the
// whole Node process, because the 'pg' pool emits an 'error' event on idle
// clients and an EventEmitter with no listener for 'error' throws by
// default. This is almost certainly what happened during onboarding testing
// 04.08.2026: the service restarted mid-request instead of just logging and
// carrying on, so Telegram never got a reply (looked like the bot "froze").
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client (pool stays up, this request will retry):', err);
});

module.exports = { pool };
