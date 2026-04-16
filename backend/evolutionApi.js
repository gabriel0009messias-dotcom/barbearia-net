function normalizarBaseUrl(url = '') {
  return String(url || '').trim().replace(/\/$/, '');
}

function getEvolutionConfig() {
  const baseUrl = normalizarBaseUrl(process.env.EVOLUTION_API_URL);
  const apiKey = String(process.env.EVOLUTION_API_KEY || '').trim();

  return {
    baseUrl,
    apiKey,
    enabled: Boolean(baseUrl && apiKey),
  };
}

function ensureEvolutionConfigured() {
  const config = getEvolutionConfig();

  if (!config.enabled) {
    const error = new Error(
      'Evolution API nao configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no servidor.'
    );
    error.statusCode = 503;
    throw error;
  }

  return config;
}

async function evolutionRequest(path, options = {}) {
  const config = ensureEvolutionConfigured();
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...options,
    headers: {
      apikey: config.apiKey,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload?.response?.message ||
        payload?.message ||
        payload?.error ||
        `Falha ao acessar Evolution API em ${path}.`
    );
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function gerarNomeInstancia(assinaturaId) {
  return `barbearia-${assinaturaId}-${Date.now()}`;
}

function construirQrCodeUrl(code = '') {
  const conteudo = String(code || '').trim();

  if (!conteudo) {
    return null;
  }

  if (conteudo.startsWith('data:image/')) {
    return conteudo;
  }

  return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(conteudo)}`;
}

async function criarInstancia(instanceName) {
  return evolutionRequest('/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  });
}

async function conectarInstancia(instanceName) {
  return evolutionRequest(`/instance/connect/${encodeURIComponent(instanceName)}`, {
    method: 'GET',
  });
}

async function obterEstadoConexao(instanceName) {
  return evolutionRequest(`/instance/connectionState/${encodeURIComponent(instanceName)}`, {
    method: 'GET',
  });
}

module.exports = {
  getEvolutionConfig,
  ensureEvolutionConfigured,
  gerarNomeInstancia,
  construirQrCodeUrl,
  criarInstancia,
  conectarInstancia,
  obterEstadoConexao,
};
