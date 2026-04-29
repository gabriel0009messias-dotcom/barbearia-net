const { attachBotHandlers } = require('./botFlow');
const { criarOpcoesWppconnect } = require('./whatsappBrowser');

const sessoes = new Map();
let wppconnectInstance = null;
const SESSION_START_TIMEOUT_MS = 45000;

function obterWppconnect() {
  if (!wppconnectInstance) {
    // Carrega o WPPConnect somente quando alguem realmente iniciar uma sessao.
    wppconnectInstance = require('@wppconnect-team/wppconnect');
  }

  return wppconnectInstance;
}

function obterSessao(assinaturaId) {
  if (!sessoes.has(assinaturaId)) {
    sessoes.set(assinaturaId, {
      status: 'nao_iniciado',
      qrCode: null,
      client: null,
      startPromise: null,
      ultimoErro: null,
      iniciadoEm: null,
      atualizadoEm: null,
    });
  }

  return sessoes.get(assinaturaId);
}

function atualizarSessao(sessao, valores = {}) {
  Object.assign(sessao, valores, {
    atualizadoEm: Date.now(),
  });
}

function sessaoTravada(sessao) {
  if (!sessao.startPromise || sessao.status !== 'iniciando' || !sessao.iniciadoEm) {
    return false;
  }

  return Date.now() - sessao.iniciadoEm > SESSION_START_TIMEOUT_MS;
}

function resetarSessaoInterna(sessao) {
  atualizarSessao(sessao, {
    status: 'nao_iniciado',
    qrCode: null,
    client: null,
    startPromise: null,
    ultimoErro: null,
    iniciadoEm: null,
  });
}

async function iniciarSessao(assinaturaId) {
  const sessao = obterSessao(assinaturaId);

  if (sessaoTravada(sessao)) {
    resetarSessaoInterna(sessao);
  }

  if (sessao.startPromise) {
    return sessao.startPromise;
  }

  atualizarSessao(sessao, {
    status: 'iniciando',
    qrCode: null,
    ultimoErro: null,
    iniciadoEm: Date.now(),
  });

  const wppconnect = obterWppconnect();

  sessao.startPromise = wppconnect
    .create(
      criarOpcoesWppconnect({
        session: `assinatura-${assinaturaId}`,
        headless: true,
        catchQR: (base64Qrimg) => {
          atualizarSessao(sessao, {
            qrCode: base64Qrimg,
            status: 'qr_pronto',
            ultimoErro: null,
          });
        },
        statusFind: (statusSession) => {
          const novoStatus = statusSession || sessao.status;
          atualizarSessao(sessao, {
            status: novoStatus,
            qrCode: ['conectado', 'isLogged', 'qrReadSuccess'].includes(novoStatus) ? null : sessao.qrCode,
            ultimoErro: ['conectado', 'isLogged', 'qrReadSuccess'].includes(novoStatus) ? null : sessao.ultimoErro,
          });
        },
      })
    )
    .then((client) => {
      atualizarSessao(sessao, {
        client,
        status: 'conectado',
        qrCode: null,
        ultimoErro: null,
        iniciadoEm: null,
      });
      attachBotHandlers(client, { sessionKey: `assinatura-${assinaturaId}`, assinaturaId });
      return client;
    })
    .catch((error) => {
      atualizarSessao(sessao, {
        status: 'erro',
        ultimoErro: error.message,
        startPromise: null,
        iniciadoEm: null,
      });
      throw error;
    })
    .finally(() => {
      sessao.startPromise = null;
    });

  return sessao.startPromise;
}

function reiniciarSessao(assinaturaId) {
  const sessao = obterSessao(assinaturaId);
  resetarSessaoInterna(sessao);
  return iniciarSessao(assinaturaId);
}

function statusSessao(assinaturaId) {
  const sessao = obterSessao(assinaturaId);

  return {
    status: sessao.status,
    qrCode: sessao.qrCode,
    ultimoErro: sessao.ultimoErro,
    iniciadoEm: sessao.iniciadoEm,
    atualizadoEm: sessao.atualizadoEm,
  };
}

function clienteSessao(assinaturaId) {
  return obterSessao(assinaturaId).client || null;
}

module.exports = {
  iniciarSessao,
  reiniciarSessao,
  statusSessao,
  clienteSessao,
};
