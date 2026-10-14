const express = require('express');
const wppconnect = require('@wppconnect-team/wppconnect');
const { logEvolutionError } = require('./evolutionApi');

require('./loadEnv');

const { attachBotHandlers } = require('./botFlow');
const { criarOpcoesWppconnect } = require('./whatsappBrowser');

const app = express();
const PORT = Number(process.env.WHATSAPP_BRIDGE_PORT || 3010);
const sessoes = new Map();
const REMINDER_CHECK_INTERVAL_MS = 60 * 1000;
const PUBLIC_STATUSES = new Set(['nao_iniciado', 'iniciando', 'qr_pronto', 'conectado', 'erro',
  'notLogged', 'isLogged', 'qrReadSuccess', 'qrReadFail', 'browserClose', 'autocloseCalled',
  'desconnectedMobile', 'inChat', 'serverClose', 'deviceNotConnected']);
for (const status of ['disconnectedMobile', 'phoneNotConnected', 'qrReadError']) PUBLIC_STATUSES.add(status);
const publicStatus = value => PUBLIC_STATUSES.has(value) ? value : 'iniciando';

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
      reminderInterval: null,
      ultimoErro: null,
      apiBaseUrl: null,
      barberToken: null,
      bridgeToken: null,
    });
  }

  return sessoes.get(assinaturaId);
}

function normalizarTelefoneWhatsapp(telefone = '') {
  const digitos = String(telefone).replace(/\D/g, '');

  if (!digitos) {
    return null;
  }

  const numeroBrasil = digitos.startsWith('55') ? digitos : `55${digitos}`;
  return `${numeroBrasil}@c.us`;
}

async function buscarApi(sessao, path, options = {}) {
  if (!sessao.apiBaseUrl || !sessao.bridgeToken) {
    throw new Error('Bot local sem token de bridge para acessar a API.');
  }

  const response = await fetch(`${String(sessao.apiBaseUrl).replace(/\/$/, '')}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-whatsapp-bridge-token': sessao.bridgeToken,
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.error || `Falha ao acessar ${path}`);
  }

  return payload;
}

function calcularMinutosAteAgendamento(data, hora) {
  const [ano, mes, dia] = String(data || '')
    .split('-')
    .map((item) => Number.parseInt(item, 10));
  const [horaNumero, minutoNumero] = String(hora || '')
    .split(':')
    .map((item) => Number.parseInt(item, 10));

  if (!ano || !mes || !dia || !Number.isInteger(horaNumero) || !Number.isInteger(minutoNumero)) {
    return null;
  }

  const agendamento = new Date(ano, mes - 1, dia, horaNumero, minutoNumero, 0, 0);
  return Math.round((agendamento.getTime() - Date.now()) / (60 * 1000));
}

function calcularDiasDesdeAgendamento(data) {
  const [ano, mes, dia] = String(data || '')
    .split('-')
    .map((item) => Number.parseInt(item, 10));

  if (!ano || !mes || !dia) {
    return null;
  }

  const agendamento = new Date(ano, mes - 1, dia, 0, 0, 0, 0);
  const hoje = new Date();
  const hojeNormalizado = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 0, 0, 0, 0);
  return Math.floor((hojeNormalizado.getTime() - agendamento.getTime()) / (24 * 60 * 60 * 1000));
}

async function verificarLembretesDaSessao(assinaturaId) {
  const sessao = obterSessao(assinaturaId);

  if (!sessao.client || !sessao.bridgeToken || !sessao.apiBaseUrl) {
    return;
  }

  const agendamentos = await buscarApi(sessao, '/api/agendamentos');
  const pendentes = agendamentos.filter((item) => {
    if (item.status !== 'confirmado' || item.lembrete_15_enviado_em) {
      return false;
    }

    const minutos = calcularMinutosAteAgendamento(item.data, item.hora);
    return Number.isInteger(minutos) && minutos <= 15 && minutos >= 0;
  });

  const posAtendimentoPendentes = agendamentos.filter((item) => {
    if (item.status !== 'confirmado' || item.lembrete_7_enviado_em) {
      return false;
    }

    const dias = calcularDiasDesdeAgendamento(item.data);
    return Number.isInteger(dias) && dias >= 7;
  });

  for (const agendamento of pendentes) {
    const telefone = normalizarTelefoneWhatsapp(agendamento.telefone);

    if (!telefone) {
      continue;
    }

    const nomeCliente = agendamento.cliente || 'Cliente';
    const mensagem = [
      `Ola, ${nomeCliente}!`,
      'Passando para lembrar do seu horario daqui a 15 minutos.',
      `Servico: ${agendamento.servico || '-'}`,
      `Data: ${new Date(`${agendamento.data}T00:00:00`).toLocaleDateString('pt-BR')}`,
      `Horario: ${agendamento.hora}`,
      '',
      'Se precisar reagendar, responda esta mensagem o quanto antes.',
    ].join('\n');

    await sessao.client.sendText(telefone, mensagem);
    await buscarApi(sessao, `/api/agendamentos/${agendamento.id}/lembrete-15`, {
      method: 'POST',
      body: JSON.stringify({ enviadoEm: new Date().toISOString() }),
    });
  }

  for (const agendamento of posAtendimentoPendentes) {
    const telefone = normalizarTelefoneWhatsapp(agendamento.telefone);

    if (!telefone) {
      continue;
    }

    const nomeCliente = agendamento.cliente || 'cliente';
    const mensagem = [
      `Ola ${nomeCliente}!`,
      '',
      `Ja se passaram quase 7 dias desde que fizemos o servico de ${agendamento.servico || 'corte'}.`,
      'Que tal agendar um horario?',
      '',
      'Estamos a disposicao!',
    ].join('\n');

    await sessao.client.sendText(telefone, mensagem);
    await buscarApi(sessao, `/api/agendamentos/${agendamento.id}/lembrete-7`, {
      method: 'POST',
      body: JSON.stringify({ enviadoEm: new Date().toISOString() }),
    });
  }
}

function iniciarLoopDeLembretes(assinaturaId) {
  const sessao = obterSessao(assinaturaId);

  if (sessao.reminderInterval) {
    clearInterval(sessao.reminderInterval);
  }

  sessao.reminderInterval = setInterval(() => {
    verificarLembretesDaSessao(assinaturaId).catch((error) => {
      logEvolutionError('legacy_bridge_reminders', error);
    });
  }, REMINDER_CHECK_INTERVAL_MS);

  verificarLembretesDaSessao(assinaturaId).catch((error) => {
    logEvolutionError('legacy_bridge_reminders_start', error);
  });
}

async function iniciarSessao(assinaturaId, contexto = {}) {
  // Private entry point: require a complete, immutable binding on every call.
  if (!/^[1-9]\d*$/.test(String(assinaturaId)) || contexto.sessionName !== undefined || !contexto.apiBaseUrl || (!contexto.bridgeToken && !contexto.barberToken)) {
    throw new Error('Contexto interno do WhatsApp invalido.');
  }
  const existing = sessoes.get(assinaturaId);
  if (existing && (existing.apiBaseUrl !== contexto.apiBaseUrl || existing.barberToken !== (contexto.barberToken || null) || existing.bridgeToken !== (contexto.bridgeToken || null))) {
    throw new Error('O vinculo interno do WhatsApp nao pode ser alterado.');
  }
  const sessao = obterSessao(assinaturaId);

  if (sessao.startPromise) {
    return sessao.startPromise;
  }

  sessao.status = 'iniciando';
  sessao.qrCode = null;
  sessao.ultimoErro = null;
  sessao.apiBaseUrl = contexto.apiBaseUrl;
  sessao.barberToken = contexto.barberToken || null;
  sessao.bridgeToken = contexto.bridgeToken || null;

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
        catchQR: (base64Qrimg) => {
          sessao.qrCode = base64Qrimg;
          sessao.status = 'qr_pronto';
          sessao.ultimoErro = null;

        },
        statusFind: (statusSession) => {
          sessao.status = publicStatus(statusSession || sessao.status);
          if (sessao.status && sessao.status !== 'erro') {
            sessao.ultimoErro = null;
          }
          console.log(`Status do WhatsApp (${assinaturaId}):`, sessao.status);
        },
      })
    )
    .then((client) => {
      sessao.client = client;
      sessao.status = 'conectado';
      sessao.ultimoErro = null;
      attachBotHandlers(client, {
        sessionKey,
        assinaturaId: Number(assinaturaId),
        apiBaseUrl: sessao.apiBaseUrl,
        barberToken: sessao.barberToken,
        bridgeToken: sessao.bridgeToken,
      });
      // Studiofy schedules persistent 20-minute reminders in the backend via Evolution.
      console.log(`Bot do WhatsApp conectado para a assinatura ${assinaturaId}.`);
      return client;
    })
    .catch((error) => {
      sessao.status = 'erro';
      sessao.qrCode = null;
      sessao.ultimoErro = 'Nao foi possivel iniciar a conexao local.';
      logEvolutionError('legacy_bridge_start', error);
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

// No per-establishment authorization exists here. Generic session routes fail closed.
app.post('/sessions/:assinaturaId/start', (req, res) => {
  res.status(403).json({ error: 'Use o fluxo autenticado do Studiofy.', errorCode: 'WHATSAPP_AUTH_REQUIRED' });
});
app.get('/sessions/:assinaturaId/status', (req, res) => {
  res.status(403).json({ error: 'Use o fluxo autenticado do Studiofy.', errorCode: 'WHATSAPP_AUTH_REQUIRED' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Bridge local do WhatsApp rodando em http://127.0.0.1:${PORT}`);
});
