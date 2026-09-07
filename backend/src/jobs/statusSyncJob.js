const env = require('../config/env');
const subscriptionRepository = require('../repositories/subscriptionRepository');
const subscriptionService = require('../services/subscriptionService');
const logService = require('../services/logService');

function startStatusSyncJob() {
  const intervalMs = env.statusSyncIntervalMinutes * 60 * 1000;

  async function run() {
    try {
      const subscriptions = await subscriptionRepository.listSubscriptionsForStatusSync();

      for (const subscription of subscriptions) {
        await subscriptionService.refreshSubscriptionStatus(subscription.id);
      }
    } catch (error) {
      await logService.error('statusSyncJob', 'Falha ao sincronizar status das assinaturas', { message: error.message });
    }
  }

  run().catch(() => {});
  return setInterval(() => {
    run().catch(() => {});
  }, intervalMs);
}

module.exports = {
  startStatusSyncJob,
};
