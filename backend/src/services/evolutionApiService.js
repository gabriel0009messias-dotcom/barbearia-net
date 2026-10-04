// Both entry points use the same transport, per-instance queue and cooldown.
const api = require('../../evolutionApi');

module.exports = {
  createEvolutionError: (message, statusCode = 502, details = null) =>
    api.createEvolutionError(message, statusCode, 'EVOLUTION_ERROR', details),
  extractQrValue: api.extrairConteudoQr,
  normalizeQrCode: api.construirQrCodeUrl,
  instanceNameForSalon: api.gerarNomeInstancia,
  fetchInstances: api.buscarInstancia,
  createInstance: api.criarInstancia,
  getConnectionState: instanceName => api.obterEstadoConexao(instanceName, { cacheMs: 10000 }),
  connectInstance: api.conectarInstancia,
};
