// Read-only diagnostic. Never calls connect/create/logout or changes the database.
require('../loadEnv');
const { randomUUID } = require('node:crypto');
const dns = require('node:dns').promises;
const { obterEstadoConexao, ensureEvolutionConfigured, evolutionRequest, logEvolutionError } = require('../evolutionApi');
const { logEvolution } = require('../evolutionLog');

async function main() {
  const instanceName = process.argv[2];
  if (instanceName && !/^[A-Za-z0-9_.-]{1,100}$/.test(instanceName)) {
    throw new Error('Uso: node scripts/diagnose-evolution.js NOME_EXATO_DA_INSTANCIA');
  }
  const requestId = randomUUID();
  const config = ensureEvolutionConfigured();
  if (!instanceName) {
    const url = new URL(config.baseUrl);
    logEvolution('diagnostic_config', { requestId, origin: url.origin, basePath: url.pathname,
      apiKeyPresent: Boolean(config.apiKey), timeoutMs: config.timeoutMs,
      render: Boolean(process.env.RENDER), node: process.version });
    const start = Date.now();
    await dns.lookup(url.hostname);
    logEvolution('diagnostic_dns_ok', { requestId, host: url.hostname, durationMs: Date.now() - start });
    for (const endpoint of ['/', '/instance/fetchInstances']) {
      try { await evolutionRequest(endpoint, { requestId, retryAttempts: 1, timeoutMs: config.timeoutMs }); }
      catch (error) { logEvolutionError('diagnostico de disponibilidade/autenticacao', error); process.exitCode = 1; }
    }
    return;
  }
  logEvolution('diagnostic_start', { requestId, instanceName, configured: config.enabled });
  try {
    const result = await obterEstadoConexao(instanceName, { requestId, timeoutMs: 12000, retryAttempts: 1 });
    logEvolution('diagnostic_result', { requestId, instanceName,
      state: result?.instance?.state || result?.state || result?.instance?.status || 'unknown' });
  } catch (error) {
    logEvolution('diagnostic_result', { requestId, instanceName, errorCode: error.code,
      statusCode: error.statusCode, rateLimitSource: error.rateLimitSource, diagnostic: error.diagnostic }, 'error');
    process.exitCode = 1;
  }
}
main().catch(error => { logEvolutionError('diagnostico', error); process.exitCode = 1; });
