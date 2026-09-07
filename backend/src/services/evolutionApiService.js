const env = require('../config/env');

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/$/, '');
}

function getConfig() {
  return {
    baseUrl: normalizeBaseUrl(env.evolutionApiUrl),
    apiKey: String(env.evolutionApiKey || '').trim(),
    timeoutMs: Math.max(1000, Number(env.evolutionApiTimeoutMs) || 90000),
    retryAttempts: Math.max(1, Number(env.evolutionApiRetryAttempts) || 3),
    retryDelayMs: Math.max(0, Number(env.evolutionApiRetryDelayMs) || 3000),
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error) {
  const statusCode = Number(error?.statusCode || 0);
  return error?.code === 'EVOLUTION_TIMEOUT' || error?.name === 'TypeError' ||
    [408, 425, 429, 500, 502, 503, 504].includes(statusCode);
}

function createEvolutionError(message, statusCode = 502, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function ensureConfigured() {
  const config = getConfig();

  if (!config.baseUrl || !config.apiKey) {
    throw createEvolutionError(
      'Evolution API nao configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no Render.',
      503
    );
  }

  return config;
}

function extractQrValue(payload = {}) {
  const candidates = [
    payload?.qrcode?.base64,
    payload?.qrcode?.code,
    payload?.qrcode,
    payload?.qrCode?.base64,
    payload?.qrCode?.code,
    payload?.qrCode,
    payload?.data?.qrcode?.base64,
    payload?.data?.qrcode?.code,
    payload?.data?.qrcode,
    payload?.data?.base64,
    payload?.data?.code,
    payload?.base64,
    payload?.code,
    payload?.qr,
    payload?.response?.qrcode?.base64,
    payload?.response?.qrcode?.code,
    payload?.response?.qrcode,
    payload?.response?.base64,
    payload?.response?.code,
  ];

  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() || null;
}

function normalizeQrCode(value) {
  if (!value) {
    return null;
  }

  if (value.startsWith('data:image/')) {
    return value;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return `data:image/png;base64,${value.replace(/^data:image\/\w+;base64,/, '')}`;
}

async function request(path, options = {}) {
  const config = ensureConfigured();
  const attempts = Math.max(1, Number(options.retryAttempts) || config.retryAttempts);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      console.info(`[Evolution API] ${options.method || 'GET'} ${path} (tentativa ${attempt}/${attempts})`);
      const response = await fetch(`${config.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          apikey: config.apiKey,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = payload?.message || payload?.error || `Evolution API respondeu HTTP ${response.status}.`;
        console.error(`[Evolution API] erro HTTP ${response.status} em ${path}: ${message}`);
        throw createEvolutionError(message, response.status, payload);
      }

      console.info(`[Evolution API] resposta recebida em ${path}: HTTP ${response.status}`);
      return payload;
    } catch (error) {
      const normalizedError = error?.name === 'AbortError'
        ? Object.assign(createEvolutionError('A Evolution API demorou para responder.', 504), { code: 'EVOLUTION_TIMEOUT' })
        : error;

      if (attempt < attempts && isRetryable(normalizedError)) {
        console.warn(`[Evolution API] nova tentativa para ${path} em ${config.retryDelayMs}ms: ${normalizedError.message}`);
        await wait(config.retryDelayMs);
        continue;
      }

      console.error(`[Evolution API] falha em ${path}: ${normalizedError.message}`);
      throw normalizedError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw createEvolutionError('Nao foi possivel acessar a Evolution API.', 502);
}

function instanceNameForSalon(salonId) {
  return `barbearia-${salonId}`;
}

async function fetchInstances(instanceName) {
  const payload = await request(`/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`);
  const instances = Array.isArray(payload) ? payload : payload?.instances || payload?.response || [];
  return instances.find((item) => {
    const name = item?.instance?.instanceName || item?.instanceName;
    return String(name || '') === instanceName;
  }) || null;
}

async function createInstance(instanceName) {
  return request('/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  });
}

async function getConnectionState(instanceName) {
  return request(`/instance/connectionState/${encodeURIComponent(instanceName)}`);
}

async function connectInstance(instanceName) {
  return request(`/instance/connect/${encodeURIComponent(instanceName)}`);
}

module.exports = {
  createEvolutionError,
  extractQrValue,
  normalizeQrCode,
  instanceNameForSalon,
  fetchInstances,
  createInstance,
  getConnectionState,
  connectInstance,
};
