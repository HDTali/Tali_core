require('dotenv').config();
const express = require('express');

const identityRoutes = require('./src/routes/identity');
const entitlementsRoutes = require('./src/routes/entitlements');
const wayforpayRoutes = require('./src/routes/wayforpay');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'tali-core-identity-billing' }));

app.use('/identity', identityRoutes);
app.use('/entitlements', entitlementsRoutes);
app.use('/webhooks/wayforpay', wayforpayRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`tali-core-identity-billing listening on ${PORT}`));
