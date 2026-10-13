const db = require('../../database');
const { instant, expiryInstant } = require('../billingTime');
const { adminBlockState } = require('../trial');
const { validateSignature } = require('./signature');
const { PROFESSIONAL_PLAN, subscriptionPlan } = require('./plan');
const { redact } = require('./diagnostics');
require('../../loadEnv');

function fail(message, statusCode = 503) {
  return Object.assign(new Error(message), { statusCode, publicMessage: message });
}

function configured() {
  return Boolean(process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim() && process.env.MERCADO_PAGO_WEBHOOK_SECRET?.trim());
}

function mode() {
  const value = process.env.MERCADO_PAGO_MODE || 'production';
  if (!['production', 'test'].includes(value)) throw fail('MERCADO_PAGO_MODE deve ser production ou test.');
  return value;
}

async function request(path, options = {}) {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim();
  if (!token) throw fail('Configure MERCADO_PAGO_ACCESS_TOKEN no servidor.');
  let response;
  try {
    response = await fetch(`https://api.mercadopago.com${path}`, {
      method: options.body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw fail('Mercado Pago indisponivel. Tente novamente.');
  }
  const data = await response.json().catch(() => ({}));
  if (path === '/checkout/preferences') {
    console.info('[Mercado Pago preference]', JSON.stringify(redact({
      event: 'preference_response', status: response.status, requestId: response.headers.get('x-request-id'),
      mode: mode(), request: options.body, response: data,
    })));
  }
  if (!response.ok) throw fail('Nao foi possivel consultar ou criar o pagamento no Mercado Pago.');
  return data;
}

function transaction(work) {
  return db.transaction(connection => work({ run: connection.runAsync, get: connection.getAsync }));
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

async function sellerEmail() {
  let seller;
  try {
    seller = await request('/users/me');
  } catch {
    throw fail('Nao foi possivel verificar a conta vendedora do Mercado Pago. Tente novamente mais tarde.');
  }
  const email = normalizeEmail(seller?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fail('Nao foi possivel identificar o e-mail da conta vendedora do Mercado Pago. Entre em contato com o suporte.');
  }
  return email;
}

const checkout = require('./checkout')({ db, request, configured, mode, sellerEmail });

async function reconcile(paymentId, expectedSubscriptionId) {
  if (expectedSubscriptionId !== undefined && (!Number.isSafeInteger(expectedSubscriptionId) || expectedSubscriptionId < 1)) throw fail('Conta esperada invalida.', 400);
  if (!/^\d+$/.test(String(paymentId))) throw fail('ID de pagamento invalido.', 400);
  const payment = await request(`/v1/payments/${paymentId}`);
  if (String(payment.id) !== String(paymentId)) throw fail('Pagamento retornado nao corresponde ao solicitado.', 422);
  return transaction(async ({ run, get }) => {
    const order = await get("SELECT * FROM mercado_pago_orders WHERE reference = $1", [payment.external_reference || '']);
    if (!order) {
      if (expectedSubscriptionId) throw fail('Pagamento nao pertence a um checkout deste sistema.', 422);
      return { ignored: true, reason: 'unknown_reference' };
    }
    if (expectedSubscriptionId !== undefined && order.assinatura_id !== expectedSubscriptionId) throw fail('Pagamento pertence a outra assinatura.', 422);
    const recorded = await get('SELECT * FROM mercado_pago_payments WHERE payment_id=$1 FOR UPDATE', [String(payment.id)]);
    if (recorded && (recorded.order_reference !== order.reference || recorded.assinatura_id !== order.assinatura_id || recorded.amount_cents !== order.amount_cents)) throw fail('Pagamento ja associado a outro pedido ou conta.', 422);
    const credited = Boolean(recorded?.credited_at) || String(order.credited_payment_id || '') === String(payment.id);
    if (payment.live_mode !== Boolean(order.live_mode) || payment.live_mode !== (mode() === 'production')) throw fail('Ambiente do pagamento incorreto.', 422);
    if (payment.currency_id !== 'BRL' || Math.round(Number(payment.transaction_amount) * 100) !== order.amount_cents) throw fail('Valor ou moeda do pagamento nao corresponde ao plano.', 422);
    if (expectedSubscriptionId && payment.status !== 'approved') throw fail('Pagamento ainda nao esta aprovado no Mercado Pago.', 409);
    const subscription = await get("SELECT * FROM assinaturas WHERE id = $1 FOR UPDATE", [order.assinatura_id]);
    if (!subscription) return { ignored: true, reason: 'subscription_removed' };
    // Capture legacy Admin intent before any payment rewrites financial status.
    // The row lock serializes this with explicit Admin unlock.
    if (adminBlockState(subscription) && subscription.bloqueio_admin !== true) {
      await run('UPDATE assinaturas SET bloqueio_admin=TRUE WHERE id=$1', [subscription.id]);
    }
    if (payment.status === 'approved' && !credited &&
        order.amount_cents !== subscriptionPlan(subscription).amountCents) {
      throw fail('O valor do pagamento difere do valor contratado. O suporte precisa conferir o pagamento antes de liberar o acesso.', 409);
    }
    await run(`INSERT INTO mercado_pago_payments (payment_id, order_reference, assinatura_id, status, amount_cents)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT(payment_id) DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP`,
    [String(payment.id), order.reference, subscription.id, payment.status, order.amount_cents]);

    if (payment.status === 'approved' && !credited) {
      const paid = new Date(instant(payment.date_approved));
      if (!payment.date_approved || !Number.isFinite(paid.getTime())) throw fail('Data de aprovacao invalida.', 422);
      const currentDue = new Date(expiryInstant(subscription));
      const paidDay = paid;
      const hasPaidPeriod = Boolean(subscription.ultimo_pagamento || subscription.payment_id);
      const base = hasPaidPeriod && currentDue >= paidDay ? currentDue : paidDay;
      const dueInstant = new Date(base.getTime() + PROFESSIONAL_PLAN.durationDays * 86400000).toISOString();
      const due = dueInstant.slice(0, 10);
      await run(`UPDATE assinaturas SET status = 'ativo', status_assinatura = 'ATIVA', bloqueado = 0,
        valor_plano = valor_mensal,
        data_bloqueio = NULL, dias_atraso = 0, gateway_provider = 'mercado_pago', gateway_status = 'approved',
        metodo_pagamento = 'mercado_pago', payment_id = $1, ultimo_pagamento = $2, proximo_vencimento = $3,
        data_vencimento = $4, vencimento_em = $6, gateway_checkout_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
      [String(payment.id), paid.toISOString().slice(0, 10), due, due, subscription.id, dueInstant]);
      await run("UPDATE mercado_pago_orders SET credited_payment_id = COALESCE(credited_payment_id, $1) WHERE reference = $2", [String(payment.id), order.reference]);
      await run("UPDATE mercado_pago_payments SET credited_at = CURRENT_TIMESTAMP,period_base=$2,period_ends=$3 WHERE payment_id = $1 AND credited_at IS NULL", [String(payment.id), base.toISOString(), dueInstant]);
      return { activated: true, assinaturaId: subscription.id };
    }
    // An old rejected payment must never undo a newer, paid period.
    if (['refunded', 'charged_back'].includes(payment.status) && String(subscription.payment_id) === String(payment.id)) {
      await run(`UPDATE assinaturas SET status = 'cancelada', status_assinatura = 'BLOQUEADA', bloqueado = 1,
        gateway_status = $1, data_bloqueio = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [payment.status, subscription.id]);
    }
    return { activated: false, status: payment.status, assinaturaId: subscription.id };
  });
}

async function webhook(req) {
  const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET?.trim();
  if (!secret) throw fail('Webhook do Mercado Pago nao configurado.');
  const id = req.query['data.id'];
  if (typeof id !== 'string' || !validateSignature({ secret, dataId: id, requestId: req.headers['x-request-id'], signatureHeader: req.headers['x-signature'] })) {
    throw fail('Assinatura do webhook invalida.', 401);
  }
  if (req.body?.data?.id != null && String(req.body.data.id) !== id) throw fail('ID da notificacao inconsistente.', 400);
  if ((req.body?.type || req.query.type) !== 'payment') return { ignored: true };
  return reconcile(id);
}

module.exports = { checkout, reconcile, webhook, configured };
