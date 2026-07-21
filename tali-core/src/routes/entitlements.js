const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/:userId', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM entitlements WHERE user_id = $1', [
    req.params.userId,
  ]);
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// Atomic usage increment at the database level — replaces the unguarded
// Airtable read-modify-write behind audit finding #10 (race condition on
// questions_used when a user sends two messages fast enough to overlap).
router.post('/:userId/increment-usage', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE entitlements SET questions_used = questions_used + 1, updated_at = now()
     WHERE user_id = $1 RETURNING *`,
    [req.params.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

module.exports = router;
