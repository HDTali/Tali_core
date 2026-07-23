require('dotenv').config();
const express = require('express');

const identityRoutes = require('./src/routes/identity');
const entitlementsRoutes = require('./src/routes/entitlements');
const wayforpayRoutes = require('./src/routes/wayforpay');
const webhookRoutes = require('./src/routes/webhook');

const app = express();

// WayForPay doesn't reliably send Content-Type: application/json on its
// serviceUrl callback, so express.json()'s default (which only parses when
// that header matches) silently leaves req.body empty. type: () => true
// forces this route to parse the body as JSON regardless of the header.
app.use('/webhooks/wayforpay', express.json({ type: () => true }));

app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'tali-core-identity-billing' }));

app.use('/identity', identityRoutes);
app.use('/entitlements', entitlementsRoutes);
app.use('/webhooks/wayforpay', wayforpayRoutes);
app.use('/webhook', webhookRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`tali-core-identity-billing listening on ${PORT}`));
