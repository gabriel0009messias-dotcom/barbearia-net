const crypto = require('node:crypto');

function validateSignature({ secret, signatureHeader, requestId, dataId }) {
  if (!secret || !signatureHeader || !requestId || !dataId) return false;
  const parts = Object.fromEntries(String(signatureHeader).split(',').map(part => part.trim().split('=')));
  if (!/^\d+$/.test(parts.ts || '') || !/^[a-f0-9]{64}$/i.test(parts.v1 || '')) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}

module.exports = { validateSignature };
