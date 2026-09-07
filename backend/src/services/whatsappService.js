const whatsappSessionRepository = require('../repositories/whatsappSessionRepository');
const evolutionApi = require('./evolutionApiService');

const startsInProgress = new Map();

function mapState(state = '') {
  const normalized = String(state || '').toLowerCase();
  if (['open', 'connected'].includes(normalized)) return 'CONNECTED';
  if (['connecting', 'pairing', 'syncing'].includes(normalized)) return 'CONNECTING';
  return 'DISCONNECTED';
}

function toStatus(session, overrides = {}) {
  return {
    salon_id: session?.salon_id,
    instance_name: session?.instance_name || null,
    status: overrides.status || session?.status || 'DISCONNECTED',
    qr_code: overrides.qrCode === undefined ? session?.qr_code || null : overrides.qrCode,
    connected_phone: session?.connected_phone || null,
    error: overrides.error || null,
  };
}

async function getStatus(salonId) {
  const current = await whatsappSessionRepository.findBySalonId(salonId);

  if (!current?.instance_name) {
    return (
      current || {
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
    const updated = await whatsappSessionRepository.upsertStatus(salonId, {
      instanceName: current.instance_name,
      status,
      qrCode: status === 'CONNECTED' ? null : current.qr_code,
      connectedPhone: current.connected_phone,
    });
    return toStatus(updated);
  } catch (error) {
    console.error(`[WhatsApp] falha ao atualizar status do salao ${salonId}: ${error.message}`);
    return toStatus(current, { error: error.message });
  }
}

async function start(salonId) {
  if (startsInProgress.has(salonId)) {
    return startsInProgress.get(salonId);
  }

  const job = startInternal(salonId).finally(() => startsInProgress.delete(salonId));
  startsInProgress.set(salonId, job);
  return job;
}

async function startInternal(salonId) {
  const current = await whatsappSessionRepository.findBySalonId(salonId);
  const instanceName = current?.instance_name || evolutionApi.instanceNameForSalon(salonId);

  console.info(`[WhatsApp] iniciando sessao do salao ${salonId} (${instanceName})`);

  let existing = await evolutionApi.fetchInstances(instanceName);
  if (!existing) {
    console.info(`[WhatsApp] criando instancia ${instanceName}`);
    try {
      await evolutionApi.createInstance(instanceName);
    } catch (error) {
      if (error.statusCode !== 409) throw error;
      console.info(`[WhatsApp] instancia ${instanceName} ja existia; reutilizando`);
    }
    existing = await evolutionApi.fetchInstances(instanceName);
  }

  const statePayload = await evolutionApi.getConnectionState(instanceName);
  const currentState = mapState(statePayload?.instance?.state);
  if (currentState === 'CONNECTED') {
    const saved = await whatsappSessionRepository.upsertStatus(salonId, {
      instanceName,
      status: 'CONNECTED',
      qrCode: null,
    });
    console.info(`[WhatsApp] conexao ja estabelecida para ${instanceName}`);
    return toStatus(saved);
  }

  const connectionPayload = await evolutionApi.connectInstance(instanceName);
  const qrCode = evolutionApi.normalizeQrCode(evolutionApi.extractQrValue(connectionPayload));
  const responseState = mapState(connectionPayload?.instance?.state);

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
    qrCode,
  });
  console.info(`[WhatsApp] ${qrCode ? 'QR Code recebido' : 'conexao estabelecida'} para ${instanceName}`);
  return toStatus(saved);
}

module.exports = {
  getStatus,
  start,
};
