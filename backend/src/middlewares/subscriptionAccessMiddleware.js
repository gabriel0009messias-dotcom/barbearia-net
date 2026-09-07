const subscriptionService = require('../services/subscriptionService');

async function requireActiveClientAccess(req, res, next) {
  try {
    const workspace = await subscriptionService.getClientWorkspace(req.user.cliente_id);

    if (!workspace.subscription) {
      res.status(403).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const refreshed = await subscriptionService.refreshSubscriptionStatus(workspace.subscription.id);

    if (refreshed.access_status === 'blocked' || refreshed.access_status === 'canceled') {
      res.status(403).json({
        error: 'Sua assinatura encontra-se em atraso.\n\nVoce possui 4 dias de tolerancia apos o vencimento.\n\nPara voltar a utilizar o sistema, regularize sua assinatura.',
        blocked: true,
      });
      return;
    }

    req.subscription = refreshed;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  requireActiveClientAccess,
};
