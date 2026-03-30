const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const wppconnect = require('@wppconnect-team/wppconnect');

const { attachBotHandlers } = require('./botFlow');
const { criarOpcoesWppconnect } = require('./whatsappBrowser');

const app = express();
const PORT = Number(process.env.WHATSAPP_BRIDGE_PORT || 3010);
const sessoes = new Map();

app.use(express.json());
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

function obterSessao(assinaturaId) {
  if (!sessoes.has(assinaturaId)) {
    sessoes.set(assinaturaId, {
      status: 'nao_iniciado',
      qrCode: null,
      client: null,
      startPromise: null,
      ultimoErro: null,
      apiBaseUrl: null,
      barberToken: null,
      bridgeToken: null,
    });
  }

  return sessoes.get(assinaturaId);
}

async function iniciarSessao(assinaturaId, contexto = {}) {
  const sessao = obterSessao(assinaturaId);

  if (sessao.startPromise) {
    return sessao.startPromise;
  }

  sessao.status = 'iniciando';
  sessao.qrCode = null;
  sessao.ultimoErro = null;
  sessao.apiBaseUrl = contexto.apiBaseUrl || sessao.apiBaseUrl;
  sessao.barberToken = contexto.barberToken || sessao.barberToken;
  sessao.bridgeToken = contexto.bridgeToken || sessao.bridgeToken;

  if (!sessao.apiBaseUrl || (!sessao.bridgeToken && !sessao.barberToken)) {
    sessao.status = 'erro';
    sessao.ultimoErro = 'Abra o painel publicado, faca login e gere o QR Code por la para autorizar o bot local.';
    return null;
  }

  const sessionKey = `assinatura-${assinaturaId}`;

  sessao.startPromise = wppconnect
    .create(
      criarOpcoesWppconnect({
        session: sessionKey,
        headless: false,
        catchQR: (base64Qrimg, asciiQR) => {
          sessao.qrCode = base64Qrimg;
          sessao.status = 'qr_pronto';

          if (asciiQR) {
            console.log(`\nQR Code do WhatsApp da assinatura ${assinaturaId}:\n`);
            console.log(asciiQR);
            return;
          }

          const base64Data = String(base64Qrimg || '').split(',')[1];

          if (base64Data) {
            qrcodeTerminal.generate(base64Data, { small: true });
          }
        },
        statusFind: (statusSession) => {
          sessao.status = statusSession || sessao.status;
          console.log(`Status do WhatsApp (${assinaturaId}):`, sessao.status);
        },
      })
    )
    .then((client) => {
      sessao.client = client;
      sessao.status = 'conectado';
      attachBotHandlers(client, {
        sessionKey,
        assinaturaId: Number(assinaturaId),
        apiBaseUrl: sessao.apiBaseUrl,
        barberToken: sessao.barberToken,
        bridgeToken: sessao.bridgeToken,
      });
      console.log(`Bot do WhatsApp conectado para a assinatura ${assinaturaId}.`);
      return client;
    })
    .catch((error) => {
      sessao.status = 'erro';
      sessao.ultimoErro = error.message;
      console.error(`Erro ao iniciar WPPConnect da assinatura ${assinaturaId}:`, error.message);
      throw error;
    })
    .finally(() => {
      sessao.startPromise = null;
    });

  return sessao.startPromise;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'whatsapp-bridge', port: PORT });
});

app.post('/sessions/:assinaturaId/start', async (req, res) => {
  const { assinaturaId } = req.params;

  try {
    await iniciarSessao(assinaturaId, req.body || {});
    const sessao = obterSessao(assinaturaId);
    res.json({
      ok: true,
      status: sessao.status,
      qrCode: sessao.qrCode,
      ultimoErro: sessao.ultimoErro,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/sessions/:assinaturaId/status', (req, res) => {
  const { assinaturaId } = req.params;
  const sessao = obterSessao(assinaturaId);

  res.json({
    status: sessao.status,
    qrCode: sessao.qrCode,
    ultimoErro: sessao.ultimoErro,
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Bridge local do WhatsApp rodando em http://127.0.0.1:${PORT}`);
});
