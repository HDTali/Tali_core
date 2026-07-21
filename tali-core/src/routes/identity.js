const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Get-or-create the internal user_id for an external identity (telegram/email/apple).
// This is the thing that makes Web/iOS/Android possible later without a rewrite:
// telegram_id stops being the primary key of a person.
router.post('/resolve', async (req, res) => {
  const { provider, external_id } = req.body || {};
  if (!provider || !external_id) {
    return res.status(400).json({ error: 'provider and external_id are required' });
  }
  if (!['telegram', 'email', 'apple'].includes(provider)) {
    return res.status(400).json({ error: 'unknown provider' });
  }

  const client = await pool.connect();
  try {
    const existing = await client.query(
      'SELECT user_id FROM identity_links WHERE provider = $1 AND external_id = $2',
      [provider, String(external_id)]
    );
    if (existing.rows.length > 0) {
      return res.json({ user_id: existing.rows[0].user_id, created: false });
    }

    await client.query('BEGIN');
    const userRow = await client.query('INSERT INTO users DEFAULT VALUES RETURNING id');
    const userId = userRow.rows[0].id;
    await client.query(
      'INSERT INTO identity_links (user_id, provider, external_id) VALUES ($1, $2, $3)',
      [userId, provider, String(external_id)]
    );
    await client.query('INSERT INTO entitlements (user_id) VALUES ($1)', [userId]);
    await client.query('COMMIT');
    return res.status(201).json({ user_id: userId, created: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('identity resolve failed', err);
    return res.status(500).json({ error: 'resolve failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
