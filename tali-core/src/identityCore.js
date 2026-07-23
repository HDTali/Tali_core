const { pool } = require('./db');

// Get-or-create the internal user_id for an external identity (telegram/email/apple).
// Pulled out of routes/identity.js so both the HTTP route (for future
// Web/iOS clients) and the Telegram webhook handler (same process, no need
// to make an HTTP call to itself) can call the exact same logic.
async function resolveIdentity(provider, externalId) {
  if (!provider || !externalId) {
    const err = new Error('provider and external_id are required');
    err.status = 400;
    throw err;
  }
  if (!['telegram', 'email', 'apple'].includes(provider)) {
    const err = new Error('unknown provider');
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    const existing = await client.query(
      'SELECT user_id FROM identity_links WHERE provider = $1 AND external_id = $2',
      [provider, String(externalId)]
    );
    if (existing.rows.length > 0) {
      return { user_id: existing.rows[0].user_id, created: false };
    }

    await client.query('BEGIN');
    const userRow = await client.query('INSERT INTO users DEFAULT VALUES RETURNING id');
    const userId = userRow.rows[0].id;
    await client.query(
      'INSERT INTO identity_links (user_id, provider, external_id) VALUES ($1, $2, $3)',
      [userId, provider, String(externalId)]
    );
    await client.query('INSERT INTO entitlements (user_id) VALUES ($1)', [userId]);
    await client.query('COMMIT');
    return { user_id: userId, created: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { resolveIdentity };
