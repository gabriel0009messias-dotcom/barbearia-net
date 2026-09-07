const webhookService = require('./webhookService');

async function processWebhook(req) {
  if (typeof webhookService.processMercadoPagoWebhook === 'function') {
    return webhookService.processMercadoPagoWebhook(req);
  }

  return null;
}

module.exports = {
  processWebhook,
};
