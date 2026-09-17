const { randomUUID } = require('node:crypto');
const { logEvolution, sanitize, sanitizeUpstreamBody } = require('./evolutionLog');
const guard = require('./evolutionConnectionGuard');
const statusRequests = new Map();
const existence = require('./evolutionExistenceCache');
function connectionKey(instance) { return `${getEvolutionConfig().baseUrl}|${instance}`; }
function tentativaConexaoAtiva(instance) { return guard.hasConnection(connectionKey(instance)); }

function normalizarBaseUrl(url = '') {
  return String(url || '').trim().replace(/\/+$/, '');
}

function obterPrimeiroEnvPreenchido(chaves = []) {
  for (const chave of chaves) {
    const valor = String(process.env[chave] || '').trim();

    if (valor) {
      return valor;
    }
  }

  return '';
}

function getEvolutionConfig() {
  const baseUrl = normalizarBaseUrl(
    obterPrimeiroEnvPreenchido(['EVOLUTION_API_URL', 'WHATSAPP_EVOLUTION_API_URL'])
  );
  const apiKey = obterPrimeiroEnvPreenchido([
    'EVOLUTION_API_KEY',
    'WHATSAPP_EVOLUTION_API_KEY',
  ]);

  return {
    baseUrl,
    apiKey,
    enabled: Boolean(baseUrl && apiKey),
    timeoutMs: Math.max(1000, Number(process.env.EVOLUTION_API_TIMEOUT_MS) || 20000),
    retryAttempts: Math.max(1, Number(process.env.EVOLUTION_API_RETRY_ATTEMPTS) || 1),
    retryDelayMs: Math.max(0, Number(process.env.EVOLUTION_API_RETRY_DELAY_MS) || 2000),
  };
}

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function createEvolutionError(message, statusCode = 500, code = 'EVOLUTION_ERROR', details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  // Consumidores legados tambem podem registrar o Error diretamente.
  error.details = sanitize(details);
  return error;
}

function logEvolutionError(contexto, error) {
  logEvolution('failure', { context: contexto, error }, 'error');
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

  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/(manager|instance)(\/|$)/i.test(url.pathname)) throw new Error('invalid');
  } catch {
    throw createEvolutionError('URL da Evolution API invalida. Configure o endereco base do servico.', 503, 'EVOLUTION_INVALID_URL');
  }

  return config;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upstream429Body(response) {
  // Bound both memory and latency. Omit incomplete bodies instead of logging partial secrets.
  let reader;
  let timer;
  const read = async () => {
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return sanitizeUpstreamBody(Buffer.concat(chunks).toString('utf8'));
      bytes += value.byteLength;
      if (bytes > 65536) return { body: '[BODY OMITTED: size limit]', bodyTruncated: true };
      chunks.push(Buffer.from(value));
    }
  };
  try {
    reader = response.body?.getReader();
    if (!reader) return { body: '', bodyTruncated: false };
    return await Promise.race([read(), new Promise(resolve => {
      timer = setTimeout(() => resolve({ body: '[BODY OMITTED: read timeout]', bodyTruncated: true }), 1000);
    })]);
  } catch {
    return { body: '[BODY OMITTED: read failure]', bodyTruncated: true };
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
  }
}

function classifyFailure(status, payload, path) {
  const technical = JSON.stringify(payload || {});
  // O guard oficial da 2.3.7 usa 403 para nome duplicado, nao apenas 409.
  if (path === '/instance/create' && status === 403 && /this name.*is already in use/i.test(technical)) return ['A instancia ja existe na Evolution API.', 409, 'EVOLUTION_INSTANCE_EXISTS'];
  if ([401, 403].includes(status)) return ['Erro de autenticacao com a Evolution API. Verifique a chave no servidor.', 502, 'EVOLUTION_INVALID_KEY'];
  if ([502, 503].includes(status)) return ['Evolution API esta offline ou indisponivel.', 503, 'EVOLUTION_OFFLINE'];
  if ([408, 504].includes(status)) return ['Tempo limite excedido ao acessar a Evolution API.', 504, 'EVOLUTION_TIMEOUT'];
  if (status === 429) return ['Evolution API recebeu muitas solicitacoes. Aguarde e tente novamente.', 429, 'EVOLUTION_RATE_LIMIT'];
  if (status === 400 && path.startsWith('/instance/logout/') && /instance.*is not connected/i.test(technical)) return ['WhatsApp ja esta desconectado.', 400, 'EVOLUTION_ALREADY_DISCONNECTED'];
  const messages = [payload?.message, payload?.response?.message, payload?.error, typeof payload === 'string' ? payload : null].flat();
  const missingInstance = messages.some(message => typeof message === 'string' && /^\s*(?:the\s+)?instance\b.*\b(?:not\s+found|does\s+not\s+exist)\b/i.test(message));
  if (status === 404 && missingInstance) return ['A instancia do WhatsApp nao foi encontrada na Evolution API.', 404, 'EVOLUTION_INSTANCE_NOT_FOUND'];
  if (path === '/instance/create' && (status === 409 || /already|duplicate|already in use/i.test(technical))) return ['A instancia ja existe na Evolution API.', 409, 'EVOLUTION_INSTANCE_EXISTS'];
  if (status === 404) return ['Endpoint da Evolution API nao encontrado. Verifique a URL e a versao do servico.', 502, 'EVOLUTION_ENDPOINT_NOT_FOUND'];
  if (path === '/instance/create') return ['Nao foi possivel criar a instancia.', 502, 'EVOLUTION_CREATE_FAILED'];
  if (path.startsWith('/instance/connect/')) return ['Nao foi possivel gerar o codigo de conexao.', 502, 'EVOLUTION_CONNECT_FAILED'];
  return ['Nao foi possivel concluir a solicitacao na Evolution API.', 502, 'EVOLUTION_REQUEST_FAILED'];
}

async function evolutionRequest(path, options = {}) {
  const endpoint = path.split('?')[0];
  const instance = options.instanceName || endpoint.split('/')[3];
  guard.checkCooldown(connectionKey('global'));
  if (instance && /^(\/instance\/|\/webhook\/set\/)/.test(endpoint)) {
    return guard.serialize(connectionKey(instance), () => requestTransport(path, options));
  }
  return requestTransport(path, options);
}

async function requestTransport(path, options = {}) {
  const config = ensureEvolutionConfigured();
  const { retryAttempts = config.retryAttempts, retryDelayMs = config.retryDelayMs,
    timeoutMs = config.timeoutMs, deadline, requestId = randomUUID(), instanceName,
    ...fetchOptions } = options;
  // Criacao e outras mutacoes nao podem ser repetidas cegamente apos timeout.
  const attempts = path.startsWith('/instance/') ? 1 : (fetchOptions.method || 'GET') === 'GET' ? Math.max(1, retryAttempts) : 1;
  const endpoint = path.split('?')[0];
  const instance = instanceName || endpoint.split('/')[3] || null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = deadline ? deadline - Date.now() : Infinity;
    const budget = Math.min(remaining, timeoutMs);
    if (budget <= 0) throw createEvolutionError('Tempo limite excedido ao acessar a Evolution API.', 504, 'EVOLUTION_TIMEOUT');
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    let httpStatus = null;
    const context = { requestId, endpoint, instance, method: fetchOptions.method || 'GET', attempt,
      origin: new URL(config.baseUrl).origin, timeoutMs: budget };
    logEvolution('request_start', context);
    try {
      const response = await fetch(`${config.baseUrl}${path}`, {
        ...fetchOptions, redirect: 'manual', signal: controller.signal,
        headers: { apikey: config.apiKey, ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}), ...(fetchOptions.headers || {}) },
      });
      httpStatus = response.status;
      if (httpStatus === 429) {
        const upstreamRetryAfter = response.headers.get('retry-after');
        const error = guard.recordRateLimit(connectionKey(instance || 'global'), upstreamRetryAfter);
        const metadata = {};
        for (const name of ['content-type', 'server', 'via', 'cf-ray', 'x-ratelimit-limit',
          'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit-limit', 'ratelimit-remaining',
          'ratelimit-reset', 'rndr-id', 'request-id', 'x-request-id']) {
          const value = response.headers.get(name);
          if (value !== null) metadata[name] = /^(?:x-)?ratelimit-/.test(name) && /^\d+$/.test(value)
            ? value.slice(0, 256) : sanitizeUpstreamBody(value).body.slice(0, 256);
        }
        const body = await upstream429Body(response);
        logEvolution('evolution_upstream_429', { ...context, httpStatus,
          statusText: sanitizeUpstreamBody(response.statusText || '').body.slice(0, 256),
          ...metadata, upstreamRetryAfter: upstreamRetryAfter === null ? null : sanitizeUpstreamBody(upstreamRetryAfter).body.slice(0, 256),
          localBackoffSeconds: error.localBackoffSeconds,
          effectiveRetryAfterSeconds: error.retryAfterSeconds, ...body });
        logEvolution('rate_limit', { ...context, httpStatus, retryAfterSeconds: error.retryAfterSeconds, retryAt: error.retryAt });
        throw error;
      }
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); }
      catch { payload = { nonJson: true, body: raw }; }
      logEvolution('request_response', { ...context, httpStatus, durationMs: Date.now() - started, response: payload });
      if (!response.ok || payload?.error) {
        const [message, status, code] = classifyFailure(httpStatus, payload, endpoint);
        if (code === 'EVOLUTION_INSTANCE_NOT_FOUND' && instance) invalidarExistenciaInstancia(instance);
        throw Object.assign(createEvolutionError(message, status, code, payload), { upstreamStatus: httpStatus });
      }
      if (payload?.nonJson || payload === null || typeof payload !== 'object') {
        throw createEvolutionError('Evolution API retornou uma resposta invalida. Verifique a URL e a inicializacao do servico.', 502, 'EVOLUTION_INVALID_RESPONSE', payload);
      }
      if (endpoint.startsWith('/instance/delete/') && instance) invalidarExistenciaInstancia(instance);
      return payload;
    } catch (original) {
      let error = original;
      if (original.name === 'AbortError' || original.name === 'TimeoutError') {
        error = createEvolutionError('Tempo limite excedido ao acessar a Evolution API.', 504, 'EVOLUTION_TIMEOUT');
      } else if (original instanceof TypeError) {
        const code = original.cause?.code;
        error = createEvolutionError(code === 'ENOTFOUND' ? 'Nao foi possivel resolver o endereco da Evolution API.' : 'Evolution API esta offline ou inacessivel pela rede.', 503,
          code === 'ENOTFOUND' ? 'EVOLUTION_DNS_ERROR' : 'EVOLUTION_OFFLINE');
      }
      if (error !== original) error.cause = original;
      logEvolution('request_failure', { ...context, httpStatus, durationMs: Date.now() - started, error }, 'error');
      const retryable = ['EVOLUTION_TIMEOUT', 'EVOLUTION_OFFLINE'].includes(error.code);
      if (attempt >= attempts || !retryable || (deadline && deadline - Date.now() <= retryDelayMs)) throw error;
    } finally {
      clearTimeout(timer);
    }
    await sleep(retryDelayMs);
  }
}

function gerarNomeInstancia(assinaturaId) {
  return `barbearia-${assinaturaId}`;
}

function extrairConteudoQr(payload = null) {
  const candidatos = [
    payload?.base64,
    payload?.qrcode?.base64,
    payload?.code,
    payload?.qrcode,
    payload?.qrcode?.code,
    payload?.qr,
    payload?.data?.code,
    payload?.data?.base64,
    payload?.data?.qrcode,
    payload?.data?.qrcode?.base64,
    payload?.data?.qrcode?.code,
    payload?.response?.code,
    payload?.response?.base64,
    payload?.response?.qrcode,
    payload?.response?.qrcode?.base64,
    payload?.response?.qrcode?.code,
    payload?.response?.qr,
  ];

  const conteudo = candidatos.find((item) => typeof item === 'string' && item.trim());

  return conteudo ? String(conteudo).trim() : '';
}

function construirQrCodeUrl(code = '') {
  const conteudo = String(code || '').trim();

  if (!conteudo) {
    return null;
  }

  if (conteudo.startsWith('data:image/')) {
    return conteudo;
  }

  if (/^[A-Za-z0-9+/=\r\n]+$/.test(conteudo) && conteudo.length > 100) {
    return `data:image/png;base64,${conteudo.replace(/\s/g, '')}`;
  }

  return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(conteudo)}`;
}

async function validarConexaoApi() {
  return evolutionRequest('/instance/fetchInstances', {
    method: 'GET',
    retryAttempts: 1,
  });
}

async function buscarInstancias(instanceName = '', options = {}) {
  const query = instanceName ? `?instanceName=${encodeURIComponent(instanceName)}` : '';
  const payload = await evolutionRequest(`/instance/fetchInstances${query}`, {
    ...options, instanceName, method: 'GET',
  });

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.response)) {
    return payload.response;
  }

  if (Array.isArray(payload?.instances)) {
    return payload.instances;
  }

  if (Array.isArray(payload?.response?.instances)) {
    return payload.response.instances;
  }

  if (payload?.instance) {
    return [payload];
  }

  throw createEvolutionError('Resposta de instancias incompativel com a Evolution API.', 502, 'EVOLUTION_INVALID_RESPONSE', payload);
}

async function buscarInstancia(instanceName, options = {}) {
  let instancias;
  try {
    instancias = await buscarInstancias(instanceName, options);
  } catch (error) {
    // Na 2.3.7, a busca filtrada retorna 404 (nao []), se o nome nao existe.
    // Apenas essa resposta autoriza o chamador a seguir para a criacao.
    if (error.code === 'EVOLUTION_INSTANCE_NOT_FOUND' && error.upstreamStatus === 404) {
      logEvolution('instance_absent', { requestId: options.requestId, instance: instanceName });
      return null;
    }
    throw error;
  }

  const nameOf = item => String(item?.instance?.instanceName || item?.instanceName || item?.name || '').trim();
  if (instancias.some(item => !nameOf(item))) throw createEvolutionError('Resposta de instancias incompativel com a Evolution API.', 502, 'EVOLUTION_INVALID_RESPONSE');
  return instancias.find(item => nameOf(item) === String(instanceName || '').trim()) || null;
}

function invalidarExistenciaInstancia(instanceName) {
  existence.invalidate(connectionKey(instanceName));
  guard.invalidateConnection(connectionKey(instanceName));
}

function extrairEstadoInstancia(payload) {
  const state = String(payload?.instance?.state || payload?.state || payload?.instance?.status || '').trim().toLowerCase();
  return ['open', 'connected', 'close', 'closed', 'disconnected', 'logout', 'connecting', 'pairing', 'syncing'].includes(state) ? state : null;
}

async function confirmarExistenciaInstancia(instanceName, options = {}) {
  ensureEvolutionConfigured();
  guard.checkCooldown(connectionKey('global'));
  guard.checkCooldown(connectionKey(instanceName));
  const { force = false, ...requestOptions } = options;
  return existence.confirm(connectionKey(instanceName), async () => Boolean(await buscarInstancia(instanceName, requestOptions)), force);
}

async function criarInstancia(instanceName, phoneNumber = '', options = {}) {
  const alwaysOnline = parseBooleanEnv(process.env.EVOLUTION_ALWAYS_ONLINE, true);
  const readMessages = parseBooleanEnv(process.env.EVOLUTION_READ_MESSAGES, false);
  const readStatus = parseBooleanEnv(process.env.EVOLUTION_READ_STATUS, false);
  const syncFullHistory = parseBooleanEnv(process.env.EVOLUTION_SYNC_FULL_HISTORY, true);

  invalidarExistenciaInstancia(instanceName);
  const result = await evolutionRequest('/instance/create', {
    ...options, instanceName, method: 'POST',
    body: JSON.stringify({
      instanceName,
      ...(String(phoneNumber || '').trim() ? { number: String(phoneNumber).trim() } : {}),
      qrcode: false,
      integration: 'WHATSAPP-BAILEYS',
      alwaysOnline,
      readMessages,
      readStatus,
      syncFullHistory,
      rejectCall: true,
      groupsIgnore: true,
    }),
  });
  existence.remember(connectionKey(instanceName));
  return result;
}

async function conectarInstancia(instanceName, phoneNumber = '', options = {}) {
  const numero = String(phoneNumber || '').trim();
  const query = numero ? `?number=${encodeURIComponent(numero)}` : '';
  return guard.connectOnce(connectionKey(instanceName), numero || 'qr', () => evolutionRequest(`/instance/connect/${encodeURIComponent(instanceName)}${query}`, {
    ...options, instanceName, method: 'GET',
  }));
}

function extrairPairingCode(payload = null) {
  const candidatos = [
    payload?.pairingCode,
    payload?.pairingcode,
    payload?.qrcode?.pairingCode,
    payload?.qrCode?.pairingCode,
    payload?.data?.pairingCode,
    payload?.data?.qrcode?.pairingCode,
    payload?.response?.pairingCode,
    payload?.response?.qrcode?.pairingCode,
  ];
  const codigo = candidatos.find((item) => typeof item === 'string' && item.trim());
  return codigo ? String(codigo).trim() : '';
}

async function obterEstadoConexao(instanceName, options = {}) {
  const key = connectionKey(instanceName);
  guard.checkCooldown(key);
  if (statusRequests.has(key)) return statusRequests.get(key);
  const job = evolutionRequest(`/instance/connectionState/${encodeURIComponent(instanceName)}`, {
    ...options, instanceName, method: 'GET', retryAttempts: 1,
  }).then(result => {
    if (extrairEstadoInstancia(result)) existence.remember(key);
    if (['open', 'connected'].includes(String(result?.instance?.state || result?.state || '').toLowerCase())) guard.invalidateConnection(key, true);
    return result;
  }).finally(() => statusRequests.delete(key));
  statusRequests.set(key, job);
  return job;
}

async function desconectarInstancia(instanceName) {
  try {
    const result = await evolutionRequest(`/instance/logout/${encodeURIComponent(instanceName)}`, {
      instanceName, timeoutMs: 15000, method: 'DELETE', retryAttempts: 1,
    });
    guard.invalidateConnection(connectionKey(instanceName));
    return result;
  } catch (error) {
    if (['EVOLUTION_INSTANCE_NOT_FOUND', 'EVOLUTION_ALREADY_DISCONNECTED'].includes(error.code)) {
      guard.invalidateConnection(connectionKey(instanceName));
    }
    throw error;
  }
}

async function configurarWebhookInstancia(instanceName, url, events = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']) {
  return evolutionRequest(`/webhook/set/${encodeURIComponent(instanceName)}`, {
    instanceName, timeoutMs: 5000,
    method: 'POST',
    body: JSON.stringify({
      webhook: { enabled: true, url, byEvents: false, base64: false, events,
        ...(process.env.EVOLUTION_WEBHOOK_SECRET ? { headers: { 'x-webhook-secret': process.env.EVOLUTION_WEBHOOK_SECRET } } : {}),
      },
    }),
    retryAttempts: 1,
  });
}

async function enviarTextoInstancia(instanceName, number, text) {
  return evolutionRequest(`/message/sendText/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({
      number,
      text,
      delay: 300,
      linkPreview: false,
    }),
  });
}

async function enviarListaInstancia(instanceName, number, options = {}) {
  return evolutionRequest(`/message/sendList/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({
      number,
      options: {
        delay: 300,
        presence: 'composing',
      },
      listMessage: {
        title: options.title || 'Atendimento',
        description: options.description || '',
        buttonText: options.buttonText || 'Selecionar',
        footerText: options.footerText || '',
        sections: options.sections || [],
      },
    }),
  });
}

module.exports = {
  tentativaConexaoAtiva,
  evolutionRequest,
  getEvolutionConfig,
  ensureEvolutionConfigured,
  createEvolutionError,
  logEvolutionError,
  gerarNomeInstancia,
  extrairConteudoQr,
  construirQrCodeUrl,
  validarConexaoApi,
  buscarInstancias,
  buscarInstancia,
  confirmarExistenciaInstancia,
  invalidarExistenciaInstancia,
  extrairEstadoInstancia,
  criarInstancia,
  conectarInstancia,
  extrairPairingCode,
  obterEstadoConexao,
  desconectarInstancia,
  configurarWebhookInstancia,
  enviarTextoInstancia,
  enviarListaInstancia,
};
