const webhookRepository = require('../repositories/webhookRepository');
const subscriptionRepository = require('../repositories/subscriptionRepository');
const mercadoPagoService = require('./mercadoPagoService');
const subscriptionService = require('./subscriptionService');

async function processMercadoPagoWebhook(req) {
  const topic = req.body.type || req.query.topic || req.body.topic || 'unknown';
  const resourceId = req.body.data?.id ? String(req.body.data.id) : req.query['data.id'] || null;
  const signature = req.headers['x-signature'] || '';
  const requestId = req.headers['x-request-id'] || '';

  const signatureValid = mercadoPagoService.validateWebhookSignature({
    requestId,
    dataId: resourceId,
    topic,
    signatureHeader: signature,
  });

  if (!signatureValid) {
    const error = new Error('Assinatura do webhook invalida.');
    error.statusCode = 401;
    throw error;
  }

  const webhookLog = await webhookRepository.createWebhookLog({
    topic,
    action: req.body.action || null,
    resourceId,
    signature,
    status: 'received',
    raw: req.body,
  });

  try {
    if (topic === 'payment' && resourceId) {
      const payment = await mercadoPagoService.getPayment(resourceId);
      const subscription =
        (payment.external_reference && (await subscriptionRepository.findByExternalReference(payment.external_reference))) ||
        (payment.subscription_id && (await subscriptionRepository.findByPreapprovalId(String(payment.subscription_id))));

      if (subscription) {
        await subscriptionService.registerPaymentFromNotification({
          subscription,
          paymentData: payment,
        });
      }
    }

    if (topic === 'subscription_preapproval' && resourceId) {
      const subscription = await subscriptionRepository.findByPreapprovalId(resourceId);
      if (subscription) {
        await subscriptionService.syncSubscriptionFromMercadoPago(subscription.id);
      }
    }

    if (topic === 'subscription_authorized_payment' && resourceId) {
      const authorizedPayment = await mercadoPagoService.getAuthorizedPayment(resourceId);
      const subscription = await subscriptionRepository.findByPreapprovalId(String(authorizedPayment.preapproval_id));

      if (subscription) {
        await subscriptionService.registerPaymentFromNotification({
          subscription,
          authorizedPaymentData: authorizedPayment,
        });
      }
    }

    await webhookRepository.markWebhookProcessed(webhookLog.id, 'processed');
  } catch (error) {
    await webhookRepository.markWebhookProcessed(webhookLog.id, 'failed', error.message);
    throw error;
  }
}

module.exports = {
  processMercadoPagoWebhook,
};
