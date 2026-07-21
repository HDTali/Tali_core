// Sanity check for the crypto primitive used in src/wayforpaySignature.js:
// HMAC-MD5, UTF-8 input, hex digest.
//
// Honest note: WayForPay's own docs page (wiki.wayforpay.com/en/view/852102)
// gives a worked example for the *Purchase request* signature (different
// field set than what we use for the serviceUrl callback). That documented
// example did NOT reproduce byte-for-byte here even after trying several
// plausible formatting variants — independently confirmed with both Node's
// crypto and Python's hmac, which agreed with each other, so this is most
// likely a stale/corrupted example on their docs page, not a bug in the
// primitive. What *does* check out below is the primitive itself against the
// official RFC 2104 HMAC-MD5 test vector — that confirms createHmac('md5',...)
// behaves correctly in general.
//
// This does NOT prove verifyCallbackSignature()/signResponse() have the right
// field order for the real callback — only WayForPay's sandbox can prove that.
// Treat "test against WayForPay's sandbox serviceUrl callback" as a hard
// requirement before this endpoint handles real payments (see README).

const crypto = require('crypto');

const rfcKey = Buffer.from('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', 'hex');
const rfcMessage = 'Hi There';
const rfcExpected = '9294727a3638bb1c13f48ef8158bfc9d';

const computed = crypto.createHmac('md5', rfcKey).update(rfcMessage, 'utf8').digest('hex');

console.log('RFC 2104 HMAC-MD5 test vector:');
console.log('  computed:', computed);
console.log('  expected:', rfcExpected);
console.log(
  computed === rfcExpected
    ? '  OK — HMAC-MD5(utf8, hex) primitive is standard-compliant.'
    : '  FAIL — something is wrong with the Node/OpenSSL build, stop and investigate.'
);
console.log('');
console.log('Reminder: this only validates the primitive, not our field order.');
console.log('Before going live, replay a real WayForPay sandbox callback through');
console.log('POST /webhooks/wayforpay and confirm verifyCallbackSignature() accepts it.');

process.exit(computed === rfcExpected ? 0 : 1);
