const { logWhatsappFailure, safeWhatsappException } = require('../../whatsappError');
const { logEvolution } = require('../../evolutionLog');
const whatsappSessionRepository = require('../repositories/whatsappSessionRepository');
const evolutionApi = require('./evolutionApiService');

const startsInProgress = new Map();

function mapState(state) {
  if (typeof state !== 'string' || state.length > 32) return 'nao_configurado';
  const normalized = state.trim().toLowerCase();
  if (['open', 'connected'].includes(normalized)) return 'CONNECTED';
  if (['connecting', 'pairing', 'syncing'].includes(normalized)) return 'CONNECTING';
  if (['close', 'closed', 'disconnected', 'logout'].includes(normalized)) return 'DISCONNECTED';
  return 'nao_configurado';
}

function toStatus(session, overrides = {}) {
  return {
    salon_id: session?.salon_id,
    instance_name: session?.instance_name || null,
    status: overrides.status || session?.status || 'DISCONNECTED',
    qr_code: evolutionApi.normalizeQrCode(overrides.qrCode === undefined
      ? (session?.instance_name && session.status !== 'CONNECTED' ? evolutionApi.getConnectionCode(session.instance_name)?.base64 || '' : '')
      : overrides.qrCode),
    connected_phone: session?.connected_phone || null,
    error: overrides.error || null,
  };
}

async function saveUnconfigured(salonId, instanceName) {
  const saved = await whatsappSessionRepository.upsertStatus(salonId, {
    instanceName, status: 'nao_configurado', qrCode: null,
  });
  return toStatus(saved, { qrCode: null });
}

async function getStatus(salonId) {
  const current = await whatsappSessionRepository.findBySalonId(salonId);

  if (!current?.instance_name) {
    return (
      current ? toStatus(current, { qrCode: null }) : {
      salon_id: salonId,
      status: 'DISCONNECTED',
      qr_code: null,
      connected_phone: null,
      instance_name: null,
      }
    );
  }

  try {
    const statePayload = await evolutionApi.getConnectionState(current.instance_name);
    const status = mapState(statePayload?.instance?.state);
    if (status === 'nao_configurado') return await saveUnconfigured(salonId, current.instance_name);
    const updated = await whatsappSessionRepository.upsertStatus(salonId, {
      instanceName: current.instance_name,
      status,
      qrCode: null,
      connectedPhone: current.connected_phone,
    });
    return toStatus(updated);
  } catch (error) {
    logWhatsappFailure(error);
    throw safeWhatsappException(error);
  }
}

async function start(salonId) {
  if (startsInProgress.has(salonId)) {
    return startsInProgress.get(salonId);
  }

  const job = startInternal(salonId).catch(error => { logWhatsappFailure(error); throw safeWhatsappException(error); }).finally(() => startsInProgress.delete(salonId));
  startsInProgress.set(salonId, job);
  return job;
}

async function startInternal(salonId) {
  const current = await whatsappSessionRepository.findBySalonId(salonId);
  const instanceName = current?.instance_name || evolutionApi.instanceNameForSalon(salonId);

  logEvolution('connection_start', { salonId, instanceName });

  let existing = await evolutionApi.fetchInstances(instanceName);
  if (!existing) {
    logEvolution('connection_start', { salonId, instanceName });
    try {
      await evolutionApi.createInstance(instanceName);
    } catch (error) {
      if (error.statusCode !== 409) throw error;
      logEvolution('connection_start', { salonId, instanceName });
    }
    existing = await evolutionApi.fetchInstances(instanceName);
  }

  const statePayload = await evolutionApi.getConnectionState(instanceName);
  const currentState = mapState(statePayload?.instance?.state);
  if (currentState === 'nao_configurado') return saveUnconfigured(salonId, instanceName);
  if (currentState === 'CONNECTED') {
    const saved = await whatsappSessionRepository.upsertStatus(salonId, {
      instanceName,
      status: 'CONNECTED',
      qrCode: null,
    });
    logEvolution('connection_start', { salonId, instanceName });
    return toStatus(saved);
  }

  const connectionPayload = await evolutionApi.connectInstance(instanceName);
  const responseState = mapState(connectionPayload?.instance?.state);
  if (Object.prototype.hasOwnProperty.call(connectionPayload?.instance || {}, 'state') && responseState === 'nao_configurado') {
    return saveUnconfigured(salonId, instanceName);
  }
  // A code-only connect response is valid; it does not supply an instance.state.
  const qrCode = evolutionApi.normalizeQrCode(evolutionApi.extractQrValue(connectionPayload));

  if (!qrCode && responseState !== 'CONNECTED') {
    throw evolutionApi.createEvolutionError(
      'A Evolution API respondeu sem QR Code. Verifique se a instancia esta habilitada para gerar QR.',
      502,
      connectionPayload
    );
  }

  const saved = await whatsappSessionRepository.upsertStatus(salonId, {
    instanceName,
    status: responseState === 'CONNECTED' ? 'CONNECTED' : 'QR_READY',
    qrCode: null,
  });
  logEvolution('connection_start', { salonId, instanceName });
  return toStatus(saved, { qrCode });
}

module.exports = {
  getStatus: (...args) => require('../../services/executionSql').accounting.run('whatsapp.alternative-status', () => getStatus(...args)),
  start: (...args) => require('../../services/executionSql').accounting.run('whatsapp.alternative-start', () => start(...args)),
};
