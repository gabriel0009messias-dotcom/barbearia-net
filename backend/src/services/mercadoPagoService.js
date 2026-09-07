const crypto = require('crypto');
const axios = require('axios');

const env = require('../config/env');

const client = axios.create({
  baseURL: env.mercadoPagoBaseUrl,
  headers: {
    Authorization: `Bearer ${env.mercadoPagoAccessToken}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

function buildIdempotencyKey(prefix = 'mp') {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function createPreapproval({ reason, payerEmail, externalReference, amountCents, backUrl }) {
  const response = await client.post(
    '/preapproval',
    {
      reason,
      payer_email: payerEmail,
      external_reference: externalReference,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: Number((amountCents / 100).toFixed(2)),
        currency_id: 'BRL',
      },
      back_url: backUrl,
      status: 'pending',
    },
    {
      headers: {
        'X-Idempotency-Key': buildIdempotencyKey('preapproval'),
      },
    }
  );

  return response.data;
}

async function getPreapproval(preapprovalId) {
  const response = await client.get(`/preapproval/${preapprovalId}`);
  return response.data;
}

async function updatePreapproval(preapprovalId, payload) {
  const response = await client.put(`/preapproval/${preapprovalId}`, payload, {
    headers: {
      'X-Idempotency-Key': buildIdempotencyKey('preapproval-update'),
    },
  });

  return response.data;
}

async function cancelPreapproval(preapprovalId) {
  return updatePreapproval(preapprovalId, { status: 'cancelled' });
}

async function getPayment(paymentId) {
  const response = await client.get(`/v1/payments/${paymentId}`);
  return response.data;
}

async function getAuthorizedPayment(authorizedPaymentId) {
  const response = await client.get(`/authorized_payments/${authorizedPaymentId}`);
  return response.data;
}

function validateWebhookSignature({ requestId, dataId, topic, signatureHeader }) {
  if (!env.mercadoPagoWebhookSecret || !signatureHeader) {
    return true;
  }

  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((item) => item.trim().split('='))
      .filter((item) => item.length === 2)
  );

  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};topic:${topic};`;
  const expected = crypto
    .createHmac('sha256', env.mercadoPagoWebhookSecret)
    .update(manifest)
    .digest('hex');

  return expected === parts.v1;
}

module.exports = {
  createPreapproval,
  getPreapproval,
  updatePreapproval,
  cancelPreapproval,
  getPayment,
  getAuthorizedPayment,
  validateWebhookSignature,
};
