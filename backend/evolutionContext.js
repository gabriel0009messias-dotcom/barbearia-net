const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const context = new AsyncLocalStorage();

function whatsappRequestContext(req, res, next) {
  if (!/^\/(?:publico\/assinaturas\/[^/]+\/)?whatsapp\//.test(req.path)) return next();
  const requestId = randomUUID();
  const reported = req.get('x-whatsapp-trigger');
  const trigger = ['section_open', 'manual_status', 'connect_click', 'poll', 'logout_click'].includes(reported) ? reported : 'unspecified';
  res.set('X-Request-Id', requestId);
  return context.run({ requestId, action: `${req.method} ${req.path}`, trigger }, next);
}

module.exports = { whatsappRequestContext, current: () => context.getStore() || {} };
