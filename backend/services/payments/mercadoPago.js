const crypto = require('node:crypto');

const db = require('../../database');
const { validateSignature } = require('./signature');
const { PROFESSIONAL_PLAN, subscriptionPlan } = require('./plan');
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
  if (!response.ok) throw fail('Nao foi possivel consultar ou criar o pagamento no Mercado Pago.');
  return data;
}

function transaction(work) {
  return db.transaction(connection => work({ run: connection.runAsync, get: connection.getAsync }));
}

async function checkout(subscription) {
  if (!configured()) throw fail('Configure as credenciais e o webhook do Mercado Pago no servidor.');
  const appUrl = String(process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!/^https:\/\/[^/]+/.test(appUrl)) throw fail('Configure PUBLIC_APP_URL com a URL HTTPS do sistema.');
  const live = mode() === 'production';
  // Read the current contract and reserve the order under the same row lock.
  // A migration cannot reprice the row between this read and recording payment intent.
  const state = await transaction(async ({ run, get }) => {
    const stored = await get('SELECT * FROM assinaturas WHERE id = $1 FOR UPDATE', [subscription.id]);
    if (!stored) throw fail('Assinatura nao encontrada.', 404);
    const plan = subscriptionPlan(stored);
    const amount = plan.amountCents;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw fail('Valor do plano invalido.', 400);
    if (!stored.email) throw fail('Cadastre um email para pagar.', 400);
    if (String(stored.status).trim().toLowerCase() === 'pendente' &&
        String(stored.status_assinatura).trim().toLowerCase() === 'pendente') {
      const conflicting = await get(`SELECT reference FROM mercado_pago_orders
        WHERE assinatura_id = $1 AND amount_cents <> $2 AND credited_payment_id IS NULL LIMIT 1`, [stored.id, amount]);
      if (conflicting) throw fail('Existe um pagamento anterior com outro valor. Entre em contato com o suporte para conferir o pagamento antes de gerar um novo checkout.', 409);
    }
    const existing = await get(`SELECT * FROM mercado_pago_orders WHERE assinatura_id = $1
      AND amount_cents = $2 AND live_mode = $3 AND credited_payment_id IS NULL AND checkout_url IS NOT NULL
      AND expires_at > $4 ORDER BY created_at DESC LIMIT 1`, [stored.id, amount, live ? 1 : 0, new Date().toISOString()]);
    if (existing) return { existing, plan, stored };
    const reference = crypto.randomUUID();
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await run(`INSERT INTO mercado_pago_orders (reference, assinatura_id, amount_cents, live_mode, expires_at)
      VALUES ($1, $2, $3, $4, $5)`, [reference, stored.id, amount, live ? 1 : 0, expiry]);
    return { reference, expiry, plan, stored };
  });
  const { plan, existing, reference, expiry } = state;
  subscription = state.stored;
  if (existing) return { init_point: existing.checkout_url, id: existing.preference_id, status: 'pending', plan };
  const backUrl = `${appUrl}/cadastro.html?assinatura=${subscription.id}&gateway=mercado_pago`;
  const preference = await request('/checkout/preferences', { body: {
    items: [{ id: plan.code, title: `${plan.name} - ${plan.durationDays} dias`, quantity: 1, currency_id: plan.currency, unit_price: plan.amountCents / 100 }],
    payer: { email: subscription.email },
    external_reference: reference,
    notification_url: `${appUrl}/api/mercadopago/webhook`,
    back_urls: { success: backUrl, pending: backUrl, failure: backUrl },
    auto_return: 'approved',
    expires: true,
    expiration_date_to: expiry,
  } });
  const checkoutUrl = live ? preference.init_point : preference.sandbox_init_point;
  if (!preference.id || !checkoutUrl || !/^https:\/\/([a-z0-9-]+\.)*mercadopago\.(com|com\.br)\//i.test(checkoutUrl)) {
    throw fail('Mercado Pago nao retornou um checkout valido.');
  }
  await transaction(async ({ run }) => {
    await run("UPDATE mercado_pago_orders SET preference_id = $1, checkout_url = $2 WHERE reference = $3", [preference.id, checkoutUrl, reference]);
    await run(`UPDATE assinaturas SET gateway_provider = 'mercado_pago', metodo_pagamento = 'mercado_pago',
      gateway_external_reference = $1, gateway_checkout_url = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [reference, checkoutUrl, subscription.id]);
  });
  return { ...preference, init_point: checkoutUrl, status: 'pending', plan };
}

async function reconcile(paymentId, expectedSubscriptionId) {
  if (!/^\d+$/.test(String(paymentId))) throw fail('ID de pagamento invalido.', 400);
  const payment = await request(`/v1/payments/${paymentId}`);
  if (String(payment.id) !== String(paymentId)) throw fail('Pagamento retornado nao corresponde ao solicitado.', 422);
  return transaction(async ({ run, get }) => {
    const order = await get("SELECT * FROM mercado_pago_orders WHERE reference = $1", [payment.external_reference || '']);
    if (!order) {
      if (expectedSubscriptionId) throw fail('Pagamento nao pertence a um checkout deste sistema.', 422);
      return { ignored: true, reason: 'unknown_reference' };
    }
    if (expectedSubscriptionId && order.assinatura_id !== expectedSubscriptionId) throw fail('Pagamento pertence a outra assinatura.', 422);
    if (payment.live_mode !== Boolean(order.live_mode) || payment.live_mode !== (mode() === 'production')) throw fail('Ambiente do pagamento incorreto.', 422);
    if (payment.currency_id !== 'BRL' || Math.round(Number(payment.transaction_amount) * 100) !== order.amount_cents) throw fail('Valor ou moeda do pagamento nao corresponde ao plano.', 422);
    if (expectedSubscriptionId && payment.status !== 'approved') throw fail('Pagamento ainda nao esta aprovado no Mercado Pago.', 409);
    const subscription = await get("SELECT * FROM assinaturas WHERE id = $1", [order.assinatura_id]);
    if (!subscription) return { ignored: true, reason: 'subscription_removed' };
    if (payment.status === 'approved' && !order.credited_payment_id &&
        order.amount_cents !== subscriptionPlan(subscription).amountCents) {
      throw fail('O valor do pagamento difere do valor contratado. O suporte precisa conferir o pagamento antes de liberar o acesso.', 409);
    }
    await run(`INSERT INTO mercado_pago_payments (payment_id, order_reference, assinatura_id, status, amount_cents)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT(payment_id) DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP`,
    [String(payment.id), order.reference, subscription.id, payment.status, order.amount_cents]);

    if (payment.status === 'approved' && !order.credited_payment_id) {
      const paid = new Date(payment.date_approved);
      if (!payment.date_approved || !Number.isFinite(paid.getTime())) throw fail('Data de aprovacao invalida.', 422);
      const currentDue = new Date(`${subscription.proximo_vencimento}T00:00:00Z`);
      const base = subscription.ultimo_pagamento && currentDue > paid ? currentDue : paid;
      const due = new Date(base.getTime() + PROFESSIONAL_PLAN.durationDays * 86400000).toISOString().slice(0, 10);
      await run(`UPDATE assinaturas SET status = 'ativo', status_assinatura = 'ATIVA', bloqueado = 0,
        valor_plano = valor_mensal,
        data_bloqueio = NULL, dias_atraso = 0, gateway_provider = 'mercado_pago', gateway_status = 'approved',
        metodo_pagamento = 'mercado_pago', payment_id = $1, ultimo_pagamento = $2, proximo_vencimento = $3,
        data_vencimento = $4, gateway_checkout_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
      [String(payment.id), paid.toISOString().slice(0, 10), due, due, subscription.id]);
      await run("UPDATE mercado_pago_orders SET credited_payment_id = $1 WHERE reference = $2", [String(payment.id), order.reference]);
      await run("UPDATE mercado_pago_payments SET credited_at = CURRENT_TIMESTAMP WHERE payment_id = $1", [String(payment.id)]);
      return { activated: true, assinaturaId: subscription.id };
    }
    // An old rejected payment must never undo a newer, paid period.
    if (['refunded', 'charged_back'].includes(payment.status) && String(subscription.payment_id) === String(payment.id)) {
      await run(`UPDATE assinaturas SET status = 'bloqueada', status_assinatura = 'BLOQUEADA', bloqueado = 1,
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
