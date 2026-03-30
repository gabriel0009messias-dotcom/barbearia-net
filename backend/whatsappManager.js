const { attachBotHandlers } = require('./botFlow');

const sessoes = new Map();
let wppconnectInstance = null;

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
    });
  }

  return sessoes.get(assinaturaId);
}

async function iniciarSessao(assinaturaId) {
  const sessao = obterSessao(assinaturaId);

  if (sessao.startPromise) {
    return sessao.startPromise;
  }

  sessao.status = 'iniciando';
  sessao.ultimoErro = null;

  const wppconnect = obterWppconnect();

  sessao.startPromise = wppconnect
    .create({
      session: `assinatura-${assinaturaId}`,
      headless: true,
      autoClose: 0,
      catchQR: (base64Qrimg) => {
        sessao.qrCode = base64Qrimg;
        sessao.status = 'qr_pronto';
      },
      statusFind: (statusSession) => {
        sessao.status = statusSession || sessao.status;
      },
      logQR: false,
      browserArgs: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    .then((client) => {
      sessao.client = client;
      sessao.status = 'conectado';
      attachBotHandlers(client, { sessionKey: `assinatura-${assinaturaId}`, assinaturaId });
      return client;
    })
    .catch((error) => {
      sessao.status = 'erro';
      sessao.ultimoErro = error.message;
      throw error;
    })
    .finally(() => {
      sessao.startPromise = null;
    });

  return sessao.startPromise;
}

function statusSessao(assinaturaId) {
  const sessao = obterSessao(assinaturaId);

  return {
    status: sessao.status,
    qrCode: sessao.qrCode,
    ultimoErro: sessao.ultimoErro,
  };
}

function clienteSessao(assinaturaId) {
  return obterSessao(assinaturaId).client || null;
}

module.exports = {
  iniciarSessao,
  statusSessao,
  clienteSessao,
};
