// Somente leitura. Execute no Shell do servico backend no Render.
require('../loadEnv');
const dns = require('node:dns').promises;
const { ensureEvolutionConfigured, evolutionRequest, logEvolutionError } = require('../evolutionApi');
const { logEvolution } = require('../evolutionLog');

async function main() {
  const config = ensureEvolutionConfigured();
  const url = new URL(config.baseUrl);
  logEvolution('diagnostic_config', { origin: url.origin, basePath: url.pathname,
    apiKeyPresent: Boolean(config.apiKey), timeoutMs: config.timeoutMs,
    render: Boolean(process.env.RENDER), node: process.version });
  const start = Date.now();
  await dns.lookup(url.hostname);
  logEvolution('diagnostic_dns_ok', { host: url.hostname, durationMs: Date.now() - start });
  // A raiz verifica se a aplicacao iniciou; fetchInstances verifica a chave global
  // e acesso ao banco. Nao cria, conecta, desconecta nem modifica instancias.
  for (const endpoint of ['/', '/instance/fetchInstances']) {
    try {
      await evolutionRequest(endpoint, { retryAttempts: 1, timeoutMs: config.timeoutMs });
    } catch (error) {
      logEvolutionError('diagnostico de disponibilidade/autenticacao', error);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => { logEvolutionError('diagnostico', error); process.exitCode = 1; });
