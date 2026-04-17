const DEFAULT_TIMEOUT_MS = Number(process.env.EVOLUTION_API_TIMEOUT_MS || 15000);
const DEFAULT_RETRY_ATTEMPTS = Number(process.env.EVOLUTION_API_RETRY_ATTEMPTS || 3);
const DEFAULT_RETRY_DELAY_MS = Number(process.env.EVOLUTION_API_RETRY_DELAY_MS || 2000);

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
    timeoutMs: Number.isFinite(DEFAULT_TIMEOUT_MS) ? DEFAULT_TIMEOUT_MS : 15000,
    retryAttempts: Number.isFinite(DEFAULT_RETRY_ATTEMPTS) ? DEFAULT_RETRY_ATTEMPTS : 3,
    retryDelayMs: Number.isFinite(DEFAULT_RETRY_DELAY_MS) ? DEFAULT_RETRY_DELAY_MS : 3000,
  };
}

function createEvolutionError(message, statusCode = 500, code = 'EVOLUTION_ERROR', details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function logEvolutionError(contexto, error) {
  const detalhes = error?.details || error?.payload || null;
  console.error(`[Evolution API] ${contexto}:`, {
    message: error?.message || String(error),
    code: error?.code || null,
    statusCode: error?.statusCode || null,
    details: detalhes,
  });
}

function ensureEvolutionConfigured() {
  const config = getEvolutionConfig();

  if (!config.enabled) {
    throw createEvolutionError(
      'Evolution API nao configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no servidor.',
      503,
      'EVOLUTION_NOT_CONFIGURED'
    );
  }

  return config;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(statusCode) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(statusCode || 0));
}

function traduzirMensagemErro(payload, fallbackMessage) {
  const mensagem = payload?.response?.message || payload?.message || payload?.error || fallbackMessage;

  if (/apikey|unauthorized|forbidden|not authorized|invalid key/i.test(String(mensagem || ''))) {
    return {
      message: 'A chave da Evolution API parece invalida ou sem permissao.',
      code: 'EVOLUTION_INVALID_KEY',
      statusCode: 401,
    };
  }

  if (/timeout|timed out|aborted/i.test(String(mensagem || ''))) {
    return {
      message: 'A Evolution API demorou para responder.',
      code: 'EVOLUTION_TIMEOUT',
      statusCode: 504,
    };
  }

  if (/not found|instance.*not.*found|does not exist|nao encontrada|inexistente/i.test(String(mensagem || ''))) {
    return {
      message: 'A instancia do WhatsApp nao foi encontrada na Evolution API.',
      code: 'EVOLUTION_INSTANCE_NOT_FOUND',
      statusCode: 404,
    };
  }

  return {
    message: mensagem || fallbackMessage,
    code: 'EVOLUTION_REQUEST_FAILED',
    statusCode: 502,
  };
}

async function evolutionRequest(path, options = {}) {
  const config = ensureEvolutionConfigured();
  const totalTentativas = Math.max(1, Number(options.retryAttempts ?? config.retryAttempts));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? config.retryDelayMs));

  for (let tentativa = 1; tentativa <= totalTentativas; tentativa += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs ?? config.timeoutMs));

    try {
      const response = await fetch(`${config.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          apikey: config.apiKey,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const traducao = traduzirMensagemErro(payload, `Falha ao acessar Evolution API em ${path}.`);
        const error = createEvolutionError(
          traducao.message,
          traducao.statusCode || response.status || 502,
          traducao.code,
          payload
        );

        if (tentativa < totalTentativas && isRetryableStatus(response.status)) {
          logEvolutionError(`tentativa ${tentativa}/${totalTentativas} em ${path}`, error);
          await sleep(retryDelayMs);
          continue;
        }

        throw error;
      }

      return payload;
    } catch (error) {
      const isAbort = error?.name === 'AbortError';
      const isFetchError = error instanceof TypeError;

      if (tentativa < totalTentativas && (isAbort || isFetchError)) {
        logEvolutionError(`tentativa ${tentativa}/${totalTentativas} em ${path}`, error);
        await sleep(retryDelayMs);
        continue;
      }

      if (isAbort) {
        throw createEvolutionError('A Evolution API demorou para responder.', 504, 'EVOLUTION_TIMEOUT');
      }

      if (isFetchError) {
        throw createEvolutionError(
          'Nao foi possivel conectar na Evolution API. Verifique a URL do servidor e se ele esta online.',
          503,
          'EVOLUTION_OFFLINE'
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw createEvolutionError('Falha ao acessar Evolution API.', 502, 'EVOLUTION_REQUEST_FAILED');
}

function gerarNomeInstancia(assinaturaId) {
  return `barbearia-${assinaturaId}`;
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

async function validarConexaoApi() {
  return evolutionRequest('/instance/fetchInstances', {
    method: 'GET',
    retryAttempts: 1,
  });
}

async function buscarInstancias(instanceName = '') {
  const query = instanceName ? `?instanceName=${encodeURIComponent(instanceName)}` : '';
  const payload = await evolutionRequest(`/instance/fetchInstances${query}`, {
    method: 'GET',
  });

  return Array.isArray(payload) ? payload : [];
}

async function buscarInstancia(instanceName) {
  const instancias = await buscarInstancias(instanceName);

  return (
    instancias.find((item) => String(item?.instance?.instanceName || '').trim() === String(instanceName || '').trim()) ||
    null
  );
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
    retryAttempts: 1,
  });
}

async function desconectarInstancia(instanceName) {
  return evolutionRequest(`/instance/logout/${encodeURIComponent(instanceName)}`, {
    method: 'DELETE',
    retryAttempts: 1,
  });
}

module.exports = {
  getEvolutionConfig,
  ensureEvolutionConfigured,
  createEvolutionError,
  logEvolutionError,
  gerarNomeInstancia,
  construirQrCodeUrl,
  validarConexaoApi,
  buscarInstancias,
  buscarInstancia,
  criarInstancia,
  conectarInstancia,
  obterEstadoConexao,
  desconectarInstancia,
};
