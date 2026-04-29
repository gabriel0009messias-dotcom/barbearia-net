const express = require('express');

const db = require('./database');

const router = express.Router();

function obterSubscriptionId(payload = {}) {
  return (
    payload?.payment?.subscription ||
    payload?.payment?.subscriptionId ||
    payload?.subscription?.id ||
    payload?.subscription ||
    null
  );
}

async function atualizarStatusPorEvento(evento, subscriptionId) {
  if (!subscriptionId) {
    return false;
  }

  let novoStatus = null;

  if (evento === 'PAYMENT_RECEIVED' || evento === 'PAYMENT_CONFIRMED') {
    novoStatus = 'ativo';
  }

  if (evento === 'PAYMENT_OVERDUE') {
    novoStatus = 'bloqueado';
  }

  if (!novoStatus) {
    return false;
  }

  const resultado = await db.runAsync(
    `UPDATE clientes_saas
     SET status = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE asaas_subscription_id = ?`,
    [novoStatus, subscriptionId]
  );

  return resultado.changes > 0;
}

router.post('/webhook', async (req, res) => {
  const evento = String(req.body?.event || '').trim();
  const subscriptionId = obterSubscriptionId(req.body);

  console.log('[Asaas webhook] Evento recebido:', {
    event: evento,
    subscriptionId,
    paymentId: req.body?.payment?.id || null,
  });

  try {
    const atualizado = await atualizarStatusPorEvento(evento, subscriptionId);

    if (atualizado) {
      console.log(`[Asaas webhook] Assinatura ${subscriptionId} atualizada para o evento ${evento}.`);
    } else {
      console.log(`[Asaas webhook] Nenhuma atualizacao aplicada para o evento ${evento}.`);
    }

    res.status(200).json({
      received: true,
      event: evento,
      subscriptionId,
      updated: atualizado,
    });
  } catch (error) {
    console.error('[Asaas webhook] Erro ao processar evento:', error.message);
    res.status(500).json({
      error: 'Erro ao processar webhook do Asaas.',
      details: error.message,
    });
  }
});

module.exports = router;
