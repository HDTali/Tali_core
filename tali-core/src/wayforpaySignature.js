const crypto = require('crypto');

/**
 * WayForPay signs everything with HMAC-MD5 over a ";"-joined, UTF-8 string of
 * specific fields (the exact fields differ per request type). Source:
 * https://wiki.wayforpay.com/en/view/852102 ("Requests authentication" /
 * "Parameters of request of gate WayForPay to serviceUrl" sections).
 *
 * Incoming serviceUrl callback signature covers:
 *   merchantAccount;orderReference;amount;currency;authCode;cardPan;transactionStatus;reasonCode
 */
function verifyCallbackSignature(payload, secretKey) {
  const fields = [
    payload.merchantAccount,
    payload.orderReference,
    payload.amount,
    payload.currency,
    payload.authCode,
    payload.cardPan,
    payload.transactionStatus,
    payload.reasonCode,
  ];
  const base = fields.map((v) => (v === undefined || v === null ? '' : String(v))).join(';');
  const expected = crypto.createHmac('md5', secretKey).update(base, 'utf8').digest('hex');
  return expected === payload.merchantSignature;
}

/**
 * The response WayForPay expects back from serviceUrl must itself carry a
 * signature over: orderReference;status;time
 */
function signResponse(orderReference, status, time, secretKey) {
  const base = [orderReference, status, time].join(';');
  return crypto.createHmac('md5', secretKey).update(base, 'utf8').digest('hex');
}

module.exports = { verifyCallbackSignature, signResponse };
