const crypto = require('node:crypto');
const { subscriptionPlan } = require('./plan');
const fail = (message, statusCode = 503) => Object.assign(new Error(message), { statusCode, publicMessage: message });
const validUrl = value => typeof value === 'string' && /^https:\/\/([a-z0-9-]+\.)*mercadopago\.(com|com\.br)\//i.test(value);

module.exports = function createCheckout({ db, request, configured, mode, sellerEmail }) {
  const tx = work => db.transaction(c => work(c));
  async function save(order, preference, plan) {
    const url = order.live_mode ? preference.init_point : preference.sandbox_init_point;
    if (typeof preference.id !== 'string' || !/^[a-zA-Z0-9-]{1,150}$/.test(preference.id) || !validUrl(url)) {
      throw fail('Mercado Pago nao retornou um checkout valido.');
    }
    await tx(async c => {
      const account = await c.getAsync('SELECT id FROM assinaturas WHERE id=$1 FOR UPDATE', [order.assinatura_id]);
      if (!account) throw fail('Assinatura removida durante a criacao do checkout.', 404);
      await c.runAsync('UPDATE mercado_pago_orders SET preference_id=$1,checkout_url=$2 WHERE reference=$3', [preference.id, url, order.reference]);
      await c.runAsync("UPDATE mercado_pago_checkout_intents SET state='ready',updated_at=CURRENT_TIMESTAMP WHERE assinatura_id=$1 AND order_reference=$2", [order.assinatura_id, order.reference]);
      await c.runAsync(`UPDATE assinaturas SET gateway_provider='mercado_pago',metodo_pagamento='mercado_pago',
        gateway_external_reference=$1,gateway_checkout_url=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3
        AND EXISTS(SELECT 1 FROM mercado_pago_orders WHERE reference=$1 AND credited_payment_id IS NULL)`,
      [order.reference, url, order.assinatura_id]);
    });
    return { id: preference.id, init_point: url, status: 'pending', plan };
  }
  async function recover(order, plan) {
    // An ambiguous POST is never repeated. Search may be eventually consistent.
    const result = await request('/checkout/preferences/search?external_reference=' + encodeURIComponent(order.reference) + '&limit=2');
    if (!Array.isArray(result.elements) || result.elements.length !== 1 || result.total !== 1) {
      throw fail('A criacao anterior ainda nao foi confirmada. Tente consultar novamente mais tarde; nenhuma nova cobranca foi criada.', 409);
    }
    const id = result.elements[0].id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,150}$/.test(id)) throw fail('Preferencia retornada invalida.');
    const preference = await request('/checkout/preferences/' + encodeURIComponent(id));
    const item = preference.items?.[0];
    if (preference.id !== id || preference.external_reference !== order.reference || preference.items?.length !== 1
        || item.quantity !== 1 || item.currency_id !== 'BRL' || Math.round(Number(item.unit_price) * 100) !== order.amount_cents
        || preference.expires !== true || Date.parse(preference.expiration_date_to) !== Date.parse(order.expires_at)) {
      throw fail('A preferencia anterior nao corresponde ao pedido. Entre em contato com o suporte.', 409);
    }
    return save(order, preference, plan);
  }
  return async function checkout(subscription) {
    if (!configured()) throw fail('Configure as credenciais e o webhook do Mercado Pago no servidor.');
    const appUrl = String(process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    if (!/^https:\/\/[^/]+/.test(appUrl)) throw fail('Configure PUBLIC_APP_URL com a URL HTTPS do sistema.');
    const live = mode() === 'production', collector = await sellerEmail();
    const state = await tx(async c => {
      const stored = await c.getAsync('SELECT * FROM assinaturas WHERE id=$1 FOR UPDATE', [subscription.id]);
      if (!stored) throw fail('Assinatura nao encontrada.', 404);
      const plan = subscriptionPlan(stored), email = String(stored.email || '').trim().toLowerCase();
      if (!Number.isSafeInteger(plan.amountCents) || plan.amountCents <= 0) throw fail('Valor do plano invalido.', 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Cadastre um e-mail valido para pagar.', 400);
      if (email === collector) throw fail('Vendedor e comprador precisam ser diferentes. Este cadastro usa o e-mail da conta vendedora do Mercado Pago. Use uma conta compradora diferente.', 409);
      const conflicting = await c.getAsync(`SELECT reference FROM mercado_pago_orders WHERE assinatura_id=$1
        AND amount_cents<>$2 AND credited_payment_id IS NULL LIMIT 1`, [stored.id, plan.amountCents]);
      if (conflicting) throw fail('Existe um pagamento anterior com outro valor. Entre em contato com o suporte antes de gerar um novo checkout.', 409);
      let order = await c.getAsync(`SELECT o.*,i.state,i.updated_at AS intent_updated_at FROM mercado_pago_checkout_intents i
        JOIN mercado_pago_orders o ON o.reference=i.order_reference AND o.assinatura_id=i.assinatura_id
        WHERE i.assinatura_id=$1 FOR UPDATE OF i,o`, [stored.id]);
      if (order && !Number.isFinite(Date.parse(order.expires_at))) throw fail('Prazo do pedido invalido. Entre em contato com o suporte.', 409);
      if (order?.credited_payment_id || (order && Date.parse(order.expires_at) <= Date.now())) order = null;
      if (!order) {
        const existing = await c.allAsync(`SELECT * FROM mercado_pago_orders WHERE assinatura_id=$1 AND credited_payment_id IS NULL
          AND expires_at::timestamptz>$2::timestamptz ORDER BY created_at DESC LIMIT 2`, [stored.id, new Date().toISOString()]);
        if (existing.length > 1) throw fail('Existem pedidos anteriores concorrentes. O suporte precisa conferir antes de gerar outro checkout.', 409);
        order = existing[0];
        if (order) {
          await c.runAsync(`INSERT INTO mercado_pago_checkout_intents(assinatura_id,order_reference,state) VALUES($1,$2,$3)
            ON CONFLICT(assinatura_id) DO UPDATE SET order_reference=excluded.order_reference,state=excluded.state,updated_at=CURRENT_TIMESTAMP`,
          [stored.id, order.reference, order.checkout_url && order.preference_id ? 'ready' : 'uncertain']);
          order.state = order.checkout_url && order.preference_id ? 'ready' : 'uncertain';
        }
      }
      if (order) {
        if (order.amount_cents !== plan.amountCents || Boolean(order.live_mode) !== live) throw fail('Pedido anterior possui valor ou ambiente diferente. Entre em contato com o suporte.', 409);
        if (order.state === 'ready') {
          if (!validUrl(order.checkout_url)) throw fail('Checkout anterior invalido.');
          return { ready: true, order, plan };
        }
        if (order.state === 'sending' && Date.now() - +new Date(order.intent_updated_at) < 20000) {
          throw fail('Checkout em criacao. Aguarde e tente consultar novamente.', 409);
        }
        return { recover: true, order, plan };
      }
      order = { reference: crypto.randomUUID(), assinatura_id: stored.id, amount_cents: plan.amountCents,
        live_mode: live ? 1 : 0, expires_at: new Date(Math.floor((Date.now() + 86400000) / 1000) * 1000).toISOString() };
      await c.runAsync('INSERT INTO mercado_pago_orders(reference,assinatura_id,amount_cents,live_mode,expires_at) VALUES($1,$2,$3,$4,$5)',
        [order.reference, order.assinatura_id, order.amount_cents, order.live_mode, order.expires_at]);
      await c.runAsync(`INSERT INTO mercado_pago_checkout_intents(assinatura_id,order_reference,state) VALUES($1,$2,'sending')
        ON CONFLICT(assinatura_id) DO UPDATE SET order_reference=excluded.order_reference,state='sending',updated_at=CURRENT_TIMESTAMP`, [stored.id, order.reference]);
      return { order, plan, email };
    });
    if (state.ready) return { id: state.order.preference_id, init_point: state.order.checkout_url, status: 'pending', plan: state.plan };
    if (state.recover) return recover(state.order, state.plan);
    const backUrl = `${appUrl}/cadastro.html?assinatura=${state.order.assinatura_id}&gateway=mercado_pago`;
    try {
      const preference = await request('/checkout/preferences', { body: {
        items: [{ id: state.plan.code, title: `${state.plan.name} - ${state.plan.durationDays} dias`, quantity: 1,
          currency_id: 'BRL', unit_price: state.order.amount_cents / 100 }],
        payer: { email: state.email }, external_reference: state.order.reference,
        notification_url: `${appUrl}/api/mercadopago/webhook`, back_urls: { success: backUrl, pending: backUrl, failure: backUrl },
        auto_return: 'approved', expires: true, expiration_date_to: state.order.expires_at,
      } });
      return await save(state.order, preference, state.plan);
    } catch (error) {
      await tx(c => c.runAsync("UPDATE mercado_pago_checkout_intents SET state='uncertain',updated_at=CURRENT_TIMESTAMP WHERE assinatura_id=$1 AND order_reference=$2 AND state='sending'", [state.order.assinatura_id, state.order.reference]));
      throw error;
    }
  };
};
