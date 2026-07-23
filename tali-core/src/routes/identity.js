const express = require('express');
const router = express.Router();
const { resolveIdentity } = require('../identityCore');

// Get-or-create the internal user_id for an external identity (telegram/email/apple).
// This is the thing that makes Web/iOS/Android possible later without a rewrite:
// telegram_id stops being the primary key of a person.
// Logic lives in ../identityCore.js so the Telegram webhook route (same
// process) can call it directly, without an HTTP round trip to itself.
router.post('/resolve', async (req, res) => {
  const { provider, external_id } = req.body || {};
  try {
    const result = await resolveIdentity(provider, external_id);
    return res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('identity resolve failed', err);
    return res.status(500).json({ error: 'resolve failed' });
  }
});

module.exports = router;
