const db = require('./database');
const { createMessageProcessor, extrairSelecao } = require('./botFlow');
const { enviarTextoInstancia, enviarListaInstancia } = require('./evolutionApi');

const { getAsync } = db;

function apenasDigitos(valor = '') {
  return String(valor || '').replace(/\D/g, '');
}

function normalizarNumeroEvolution(telefone = '') {
  const digitos = apenasDigitos(String(telefone || '').replace(/@c\.us$/i, ''));
  return digitos.startsWith('55') ? digitos : `55${digitos}`;
}

function extrairEventoWebhook(payload = {}) {
  return String(payload.event || payload.type || '').trim().toUpperCase();
}

function extrairEnvelopeMensagem(payload = {}) {
  const data = payload.data || payload;
  const key = data.key || {};
  const message = data.message || {};
  const from = key.remoteJid || data.remoteJid || data.from || '';

  if (!from || String(from).includes('@g.us') || key.fromMe) {
    return null;
  }

  return {
    instanceName:
      payload.instance || payload.instanceName || data.instance || data.instanceName || data.sender || '',
    from,
    body:
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      message.listResponseMessage?.title ||
      message.buttonsResponseMessage?.selectedDisplayText ||
      data.body ||
      '',
    selectedButtonId: message.buttonsResponseMessage?.selectedButtonId || null,
    listResponse: message.listResponseMessage || null,
    rowId: message.listResponseMessage?.singleSelectReply?.selectedRowId || null,
    type: data.messageType || payload.event || 'evolution_webhook',
    fromMe: Boolean(key.fromMe),
  };
}

function criarClienteEvolution(instanceName) {
  return {
    async sendText(user, texto) {
      await enviarTextoInstancia(instanceName, normalizarNumeroEvolution(user), texto);
      return { key: { id: `evo-text-${Date.now()}` } };
    },
    async sendPollMessage(user, pergunta, opcoes) {
      await enviarListaInstancia(instanceName, normalizarNumeroEvolution(user), {
        title: pergunta,
        description: 'Selecione uma opção',
        buttonText: 'Mostrar opções',
        footerText: '',
        sections: [
          {
            title: 'Atendimento',
            rows: opcoes.map((opcao) => ({
              title: opcao,
              description: '',
              rowId: opcao,
            })),
          },
        ],
      });

      return { key: { id: `evo-poll-${Date.now()}` } };
    },
    async sendListMessage(user, options = {}) {
      await enviarListaInstancia(instanceName, normalizarNumeroEvolution(user), {
        title: options.title || 'Atendimento',
        description: options.description || '',
        buttonText: options.buttonText || 'Mostrar opções',
        footerText: options.footer || '',
        sections: (options.sections || []).map((section) => ({
          title: section.title || 'Opções',
          rows: (section.rows || []).map((row) => ({
            title: row.title,
            description: row.description || '',
            rowId: row.rowId || row.title,
          })),
        })),
      });

      return { key: { id: `evo-list-${Date.now()}` } };
    },
    async deleteMessage() {
      return null;
    },
  };
}

async function buscarAssinaturaPorInstancia(instanceName = '') {
  const nome = String(instanceName || '').trim();

  if (!nome) {
    return null;
  }

  return getAsync('SELECT * FROM assinaturas WHERE whatsapp_session = ? LIMIT 1', [nome]);
}

async function processarWebhookEvolution(payload = {}) {
  const evento = extrairEventoWebhook(payload);

  if (evento && evento !== 'MESSAGES_UPSERT') {
    return { ok: true, ignored: true, event: evento };
  }

  const envelope = extrairEnvelopeMensagem(payload);

  if (!envelope || envelope.fromMe) {
    return { ok: true, ignored: true, event: evento || 'MESSAGES_UPSERT' };
  }

  const assinatura = await buscarAssinaturaPorInstancia(envelope.instanceName);

  if (!assinatura?.id) {
    throw new Error('Nao encontrei a assinatura vinculada a esta instancia do WhatsApp.');
  }

  const client = criarClienteEvolution(envelope.instanceName);
  const processarEntrada = createMessageProcessor(client, {
    sessionKey: `assinatura-${assinatura.id}`,
    assinaturaId: assinatura.id,
  });

  const entrada = {
    from: envelope.from,
    type: envelope.type,
    fromMe: false,
    ...extrairSelecao(envelope),
  };

  await processarEntrada(entrada);

  return {
    ok: true,
    assinaturaId: assinatura.id,
    instanceName: envelope.instanceName,
    from: envelope.from,
  };
}

module.exports = {
  processarWebhookEvolution,
};
