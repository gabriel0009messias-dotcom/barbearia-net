// Temporary maintenance route. Remove this file and its registration after use.
const crypto = require('node:crypto');
const { configurarWebhookInstancia, evolutionRequest } = require('./evolutionApi');

const ROUTE = '/admin/whatsapp/barbearia-6/webhook-temporario';
const INSTANCE = 'barbearia-6';
const URL = 'https://barbearia-net.onrender.com/api/webhook/evolution';
const EVENTS = ['CONNECTION_UPDATE', 'QRCODE_UPDATED', 'MESSAGES_UPSERT'];

function registerTemporaryEvolutionWebhookAdmin(router, requireAdmin) {
  let busy = false;
  let confirmed = false; // Per-process: after success, subsequent calls only read.

  router.post(ROUTE, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Preserve the existing admin session validation, with boolean-only errors.
    requireAdmin(req, {
      status(code) { res.status(code); return this; },
      json() { return res.json({ autorizado: false }); },
    }, next);
  }, async (req, res) => {
    if (Object.keys(req.query || {}).length ||
        (req.body != null && (typeof req.body !== 'object' ||
          Array.isArray(req.body) || Object.keys(req.body).length))) {
      return res.status(400).json({ parametrosAceitos: false });
    }
    const secret = process.env.EVOLUTION_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ segredoConfigurado: false });
    if (busy) return res.status(409).json({ operacaoEmAndamento: true });

    busy = true;
    let configurationApplied = false;
    try {
      if (!confirmed) {
        await configurarWebhookInstancia(INSTANCE, URL, [...EVENTS]);
        configurationApplied = true;
      }
      const saved = await evolutionRequest(`/webhook/find/${INSTANCE}`, {
        instanceName: INSTANCE, method: 'GET', timeoutMs: 10000, retryAttempts: 1,
      });
      const header = saved.headers?.['x-webhook-secret'];
      const headerSaved = typeof header === 'string' && header.length > 0;
      const checks = {
        autorizado: true,
        configuracaoAplicada: configurationApplied,
        somenteVerificacao: !configurationApplied,
        habilitado: saved.enabled === true,
        headerSalvo: headerSaved,
        headerIgualAoEnvironment: headerSaved &&
          Buffer.byteLength(header) === Buffer.byteLength(secret) &&
          crypto.timingSafeEqual(Buffer.from(header), Buffer.from(secret)),
        urlCorreta: saved.url === URL,
        eventosCorretos: Array.isArray(saved.events) &&
          saved.events.length === EVENTS.length &&
          EVENTS.every(event => saved.events.includes(event)),
        byEventsDesativado: saved.webhookByEvents === false,
        base64Desativado: saved.webhookBase64 === false,
      };
      checks.verificacaoConcluida = ['habilitado', 'headerSalvo',
        'headerIgualAoEnvironment', 'urlCorreta', 'eventosCorretos',
        'byEventsDesativado', 'base64Desativado'].every(key => checks[key]);
      if (checks.verificacaoConcluida) confirmed = true;
      return res.status(checks.verificacaoConcluida ? 200 : 502).json(checks);
    } catch {
      // Never return or log upstream responses/errors: they can contain secrets.
      return res.status(502).json({ autorizado: true,
        configuracaoAplicada: configurationApplied, verificacaoConcluida: false });
    } finally {
      busy = false;
    }
  });
}

module.exports = { registerTemporaryEvolutionWebhookAdmin };
