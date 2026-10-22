const supervision = require('./services/supervision/context');
supervision.assertRuntimeImport();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

require('./loadEnv');

const apiRoutes = require('./routes');
const { handleWhatsappWebhook } = require('./whatsappWebhook');

function obterPrimeiroEnvPreenchido(chaves = [], fallback = '') {
  for (const chave of chaves) {
    const valor = String(process.env[chave] || '').trim();

    if (valor) {
      return valor;
    }
  }

  return fallback;
}

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT === '0' ? 0 : Number(process.env.PORT) || 3000;
const painelPath = path.join(__dirname, 'public');
const runtimeErrorLogPath = path.join(__dirname, 'server-error.log');
const assinaturasCadastradas = [];
const barbeiroSessions = new Map();
const adminSessions = new Map();
const ADMIN_EMAIL = obterPrimeiroEnvPreenchido(['LEGACY_ADMIN_EMAIL', 'ADMIN_EMAIL', 'SUPER_ADMIN_EMAIL']);
const ADMIN_PASSWORD = obterPrimeiroEnvPreenchido(['LEGACY_ADMIN_PASSWORD', 'ADMIN_PASSWORD', 'SUPER_ADMIN_PASSWORD']);
const LEGACY_DEMO_EMAIL = obterPrimeiroEnvPreenchido(['LEGACY_DEMO_EMAIL']);
const LEGACY_DEMO_PASSWORD = obterPrimeiroEnvPreenchido(['LEGACY_DEMO_PASSWORD']);
let suporteNumeroAdmin = '--';
const ACESSO_VITALICIO = {
  id: 1,
  email: LEGACY_DEMO_EMAIL,
  senha: LEGACY_DEMO_PASSWORD,
  barbeariaNome: 'Salão Demo',
  responsavelNome: 'Administrador Demo',
  telefone: '',
  status: 'ativo',
  whatsapp_status: 'nao_configurado',
  dias_funcionamento: [1, 2, 3, 4, 5, 6],
  horario_abertura: '08:00',
  horario_almoco_inicio: '12:00',
  horario_almoco_fim: '13:00',
  horario_fechamento: '18:00',
  servicos: [
    { id: 1, nome: 'Corte degrade', preco: 30 },
    { id: 2, nome: 'Luzes', preco: 80 },
  ],
};
const demoAgendamentos = [];
const demoBloqueios = [];

function registrarErroRuntime(tipo, erro) {
  const mensagem = erro instanceof Error ? `${erro.stack || erro.message}` : String(erro);
  const linha = `[${new Date().toISOString()}] ${tipo}\n${mensagem}\n\n`;

  console.error(`${tipo}:`, erro);

  try {
    fs.appendFileSync(runtimeErrorLogPath, linha, 'utf8');
  } catch (logError) {
    console.error('Nao foi possivel gravar em server-error.log:', logError);
  }
}

process.on('unhandledRejection', (erro) => {
  registrarErroRuntime('unhandledRejection', erro);
});

process.on('uncaughtException', (erro) => {
  registrarErroRuntime('uncaughtException', erro);
});

function normalizarEmail(email = '') {
  return String(email || '').trim().toLowerCase();
}

function credenciaisAdminConfiguradas() {
  return Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);
}

function demoLegadoConfigurado() {
  return Boolean(ACESSO_VITALICIO.email && ACESSO_VITALICIO.senha);
}

function normalizarServicosPainel(servicos = []) {
  return Array.isArray(servicos)
    ? servicos
        .filter((item) => item?.nome && Number(item?.preco) > 0)
        .map((item, index) => ({
          id: index + 1,
          nome: String(item.nome).trim(),
          preco: Number(item.preco),
        }))
    : [];
}

function criarDadosPainelDaAssinatura(assinatura = {}) {
  return {
    id: assinatura.id,
    email: assinatura.email,
    senha: assinatura.senha,
    barbeariaNome: assinatura.barbeariaNome,
    responsavelNome: assinatura.responsavelNome,
    telefone: assinatura.telefone,
    status: assinatura.status || 'pendente',
    whatsapp_status: assinatura.whatsapp_status || 'nao_configurado',
    dias_funcionamento:
      Array.isArray(assinatura.dias_funcionamento) && assinatura.dias_funcionamento.length
        ? assinatura.dias_funcionamento
        : [1, 2, 3, 4, 5, 6],
    horario_abertura: assinatura.horario_abertura || '08:00',
    horario_almoco_inicio: assinatura.horario_almoco_inicio || '12:00',
    horario_almoco_fim: assinatura.horario_almoco_fim || '13:00',
    horario_fechamento: assinatura.horario_fechamento || '18:00',
    servicos:
      Array.isArray(assinatura.servicos) && assinatura.servicos.length
        ? assinatura.servicos
        : [
            { id: 1, nome: 'Corte degrade', preco: 30 },
            { id: 2, nome: 'Luzes', preco: 80 },
          ],
  };
}

function obterAssinaturaPorId(id) {
  if (Number(id) === ACESSO_VITALICIO.id) {
    return ACESSO_VITALICIO;
  }

  return assinaturasCadastradas.find((item) => item.id === Number(id)) || null;
}

function obterAssinaturaPorCredenciais(email, senha) {
  return (
    assinaturasCadastradas.find(
      (item) => normalizarEmail(item.email) === normalizarEmail(email) && String(item.senha || '') === String(senha || '')
    ) || null
  );
}

function precoDoServico(nomeServico = '') {
  const servico = ACESSO_VITALICIO.servicos.find(
    (item) => String(item.nome || '').trim().toLowerCase() === String(nomeServico || '').trim().toLowerCase()
  );

  return Number(servico?.preco || 0);
}

function encontrarServicoPorIdOuNome(servicoId, servicoNome) {
  const porId = Number(servicoId);

  if (Number.isInteger(porId) && porId > 0) {
    const encontradoPorId = ACESSO_VITALICIO.servicos.find((item) => Number(item.id) === porId);
    if (encontradoPorId) {
      return encontradoPorId;
    }
  }

  return ACESSO_VITALICIO.servicos.find(
    (item) => String(item.nome || '').trim().toLowerCase() === String(servicoNome || '').trim().toLowerCase()
  );
}

function filtrarAgendamentosConfirmados() {
  return demoAgendamentos.filter((item) => String(item.status || '').toLowerCase() === 'confirmado');
}

function somarPorPeriodo(periodo, referenciaMes = '') {
  const hoje = new Date();
  const hojeIso = hoje.toISOString().slice(0, 10);
  const mesAtual = hojeIso.slice(0, 7);
  const anoAtual = hojeIso.slice(0, 4);

  return filtrarAgendamentosConfirmados()
    .filter((item) => {
      const data = String(item.data || '');

      if (!data) {
        return false;
      }

      if (periodo === 'dia') {
        return data === hojeIso;
      }

      if (periodo === 'mes') {
        return data.slice(0, 7) === mesAtual;
      }

      if (periodo === 'ano') {
        return data.slice(0, 4) === anoAtual;
      }

      if (periodo === 'mes_customizado') {
        return referenciaMes && data.slice(0, 7) === referenciaMes;
      }

      return false;
    })
    .reduce((total, item) => total + precoDoServico(item.servico), 0);
}

app.use(express.json({ limit: '6mb' }));
app.use(express.static(painelPath));
// Prioriza o backend modular persistido antes das rotas legadas em memoria.
app.use('/api', apiRoutes);
app.get('/agendar/:slug', (req, res) => res.sendFile(path.join(painelPath, 'agendar.html')));

app.get('/', (req, res) => {
  res.sendFile(path.join(painelPath, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'barbearia-backend',
    version: process.env.RENDER_GIT_COMMIT || null,
    reminders: require('./services/reminders').getWorkerStatus(),
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'barbearia-api',
    version: process.env.RENDER_GIT_COMMIT || null,
    reminders: require('./services/reminders').getWorkerStatus(),
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get('/cadastro.html', (req, res) => {
  res.sendFile(path.join(painelPath, 'cadastro.html'));
});

app.get('/barbeiro.html', (req, res) => {
  res.sendFile(path.join(painelPath, 'barbeiro.html'));
});

app.get('/controle-interno', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.redirect('/controle-interno.html');
});

app.get('/controle-interno.html', (req, res) => {
  res.sendFile(path.join(painelPath, 'controle-interno.html'));
});

function obterSessaoBarbeiro(req) {
  const token = String(req.headers['x-barbeiro-token'] || '').trim();

  if (!token || !barbeiroSessions.has(token)) {
    return null;
  }

  return barbeiroSessions.get(token);
}

function requireBarbeiro(req, res, next) {
  const sessao = obterSessaoBarbeiro(req);

  if (!sessao) {
    res.status(401).json({ error: 'Login obrigatorio.' });
    return;
  }

  req.sessaoBarbeiro = sessao;
  next();
}

function obterTokenBridgeWhatsapp(req) {
  return String(req.headers['x-whatsapp-bridge-token'] || '').trim();
}

function requireBarbeiroOuBridge(req, res, next) {
  const sessao = obterSessaoBarbeiro(req);

  if (sessao) {
    req.sessaoBarbeiro = sessao;
    req.autenticadoViaBridge = false;
    next();
    return;
  }

  const bridgeToken = obterTokenBridgeWhatsapp(req);

  if (bridgeToken && bridgeToken === 'demo-bridge-token') {
    req.autenticadoViaBridge = true;
    next();
    return;
  }

  res.status(401).json({ error: 'Login obrigatorio.' });
}

function obterTokenAdmin(req) {
  return String(req.headers['x-admin-token'] || '').trim();
}

function requireAdmin(req, res, next) {
  const token = obterTokenAdmin(req);

  if (!token || !adminSessions.has(token)) {
    res.status(401).json({ error: 'Acesso admin nao autorizado.' });
    return;
  }

  req.adminToken = token;
  next();
}

function listarAssinaturasAdmin() {
  const acessoVitalicio = {
    id: ACESSO_VITALICIO.id,
    barbearia_nome: ACESSO_VITALICIO.barbeariaNome,
    responsavel_nome: ACESSO_VITALICIO.responsavelNome,
    telefone: ACESSO_VITALICIO.telefone,
    email: ACESSO_VITALICIO.email,
    metodo_pagamento: 'acesso_liberado',
    dia_vencimento: '-',
    status: ACESSO_VITALICIO.status,
  };

  const cadastradas = assinaturasCadastradas.map((assinatura) => ({
    id: assinatura.id,
    barbearia_nome: assinatura.barbeariaNome,
    responsavel_nome: assinatura.responsavelNome,
    telefone: assinatura.telefone,
    email: assinatura.email,
    metodo_pagamento: assinatura.metodoPagamento,
    dia_vencimento: assinatura.diaVencimento,
    status: assinatura.status,
  }));

  return [acessoVitalicio, ...cadastradas];
}

app.post('/api/barbeiro/login', (req, res) => {
  const identificador = normalizarEmail(req.body?.identificador || '');
  const senha = String(req.body?.senha || '');

  let assinatura = null;
  let tipo = 'assinatura';

  if (demoLegadoConfigurado() && identificador === normalizarEmail(ACESSO_VITALICIO.email) && senha === ACESSO_VITALICIO.senha) {
    assinatura = ACESSO_VITALICIO;
    tipo = 'acesso_vitalicio';
  } else {
    assinatura = obterAssinaturaPorCredenciais(identificador, senha);
  }

  if (!assinatura) {
    res.status(401).json({ error: 'Gmail ou senha invalidos.' });
    return;
  }

  if (assinatura.status !== 'ativo') {
    res.status(403).json({ error: 'Pagamento pendente. Assim que o pagamento for confirmado, o painel sera liberado automaticamente.' });
    return;
  }

  const token = crypto.randomBytes(24).toString('hex');
  barbeiroSessions.set(token, {
    assinaturaId: assinatura.id,
    email: assinatura.email,
    tipo,
  });

  res.json({
    token,
    assinatura: {
      id: assinatura.id,
      email: assinatura.email,
      status: assinatura.status,
    },
  });
});

app.post('/api/admin/login', (req, res) => {
  const email = normalizarEmail(req.body?.email || '');
  const senha = String(req.body?.senha || '');

  if (!credenciaisAdminConfiguradas()) {
    res.status(503).json({ error: 'Credenciais do admin nao configuradas neste ambiente.' });
    return;
  }

  if (email !== normalizarEmail(ADMIN_EMAIL) || senha !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Email ou senha incorretos.' });
    return;
  }

  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, { createdAt: Date.now() });
  res.json({ token, expiresInHours: 12 });
});

app.get('/api/admin/assinaturas', requireAdmin, (req, res) => {
  res.json(listarAssinaturasAdmin());
});

app.patch('/api/admin/assinaturas/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '').trim().toLowerCase();

  if (!['pendente', 'ativo', 'bloqueado'].includes(status)) {
    res.status(400).json({ error: 'Status invalido.' });
    return;
  }

  if (id === ACESSO_VITALICIO.id) {
    ACESSO_VITALICIO.status = status;
    res.json({
      id: ACESSO_VITALICIO.id,
      status: ACESSO_VITALICIO.status,
    });
    return;
  }

  const assinatura = assinaturasCadastradas.find((item) => item.id === id);

  if (!assinatura) {
    res.status(404).json({ error: 'Assinatura nao encontrada.' });
    return;
  }

  assinatura.status = status;
  res.json({
    id: assinatura.id,
    status: assinatura.status,
  });
});

app.delete('/api/admin/assinaturas/:id', requireAdmin, (req, res) => {
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
    res.status(410).json({ error: 'Remocao legado-admin desativada no ambiente hospedado.' });
    return;
  }

  const id = Number(req.params.id);

  if (id === ACESSO_VITALICIO.id) {
    res.status(400).json({ error: 'O acesso vitalicio principal nao pode ser excluido por aqui.' });
    return;
  }

  const index = assinaturasCadastradas.findIndex((item) => item.id === id);

  if (index === -1) {
    res.status(404).json({ error: 'Assinatura nao encontrada.' });
    return;
  }

  const [removida] = assinaturasCadastradas.splice(index, 1);

  res.json({
    ok: true,
    removida: {
      id: removida.id,
      barbearia_nome: removida.barbeariaNome,
      email: removida.email,
    },
  });
});

app.get('/api/barbeiro/me', (req, res) => {
  const sessao = obterSessaoBarbeiro(req);

  if (!sessao) {
    res.status(401).json({ error: 'Login obrigatorio.' });
    return;
  }

  const assinaturaBase = obterAssinaturaPorId(sessao.assinaturaId);

  if (!assinaturaBase) {
    res.status(404).json({ error: 'Assinatura nao encontrada.' });
    return;
  }

  const assinatura = criarDadosPainelDaAssinatura(assinaturaBase);

  res.json({
    id: assinatura.id,
    email: assinatura.email,
    barbearia_nome: assinatura.barbeariaNome,
    responsavel_nome: assinatura.responsavelNome,
    telefone: assinatura.telefone,
    status: assinatura.status,
    whatsapp_status: assinatura.whatsapp_status,
    dias_funcionamento: assinatura.dias_funcionamento,
    horario_abertura: assinatura.horario_abertura,
    horario_almoco_inicio: assinatura.horario_almoco_inicio,
    horario_almoco_fim: assinatura.horario_almoco_fim,
    horario_fechamento: assinatura.horario_fechamento,
    servicos: assinatura.servicos,
  });
});

app.get('/api/agendamentos', requireBarbeiroOuBridge, (req, res) => {
  res.json(demoAgendamentos);
});

app.get('/api/faturamento', requireBarbeiro, (req, res) => {
  const periodo = String(req.query?.periodo || 'mes').trim().toLowerCase();
  const mes = String(req.query?.mes || '').trim();

  if (periodo === 'mes_customizado') {
    if (!/^\d{4}-\d{2}$/.test(mes)) {
      res.status(400).json({ error: 'Informe o mes no formato YYYY-MM.' });
      return;
    }

    res.json({ total: somarPorPeriodo('mes_customizado', mes), referencia: mes });
    return;
  }

  res.json({ total: somarPorPeriodo(periodo) });
});

app.get('/api/bloqueios', requireBarbeiroOuBridge, (req, res) => {
  res.json(demoBloqueios);
});

app.post('/api/bloqueios', requireBarbeiro, (req, res) => {
  const { data, hora } = req.body;

  if (!data || !hora) {
    res.status(400).json({ error: 'Informe data e hora.' });
    return;
  }

  const bloqueio = {
    id: Date.now(),
    data,
    hora,
  };

  demoBloqueios.push(bloqueio);
  res.status(201).json(bloqueio);
});

app.delete('/api/agendamentos/:id', requireBarbeiro, (req, res) => {
  const id = Number(req.params.id);
  const index = demoAgendamentos.findIndex((item) => item.id === id);

  if (index >= 0) {
    demoAgendamentos.splice(index, 1);
  }

  res.json({ success: true });
});

app.get('/api/publico/assinaturas/:id', requireBarbeiroOuBridge, (req, res) => {
  const assinaturaBase = obterAssinaturaPorId(req.params.id);

  if (!assinaturaBase) {
    res.status(404).json({ error: 'Assinatura nao encontrada.' });
    return;
  }

  const assinatura = criarDadosPainelDaAssinatura(assinaturaBase);

  res.json({
    id: assinatura.id,
    dias_funcionamento: assinatura.dias_funcionamento,
    horario_abertura: assinatura.horario_abertura,
    horario_almoco_inicio: assinatura.horario_almoco_inicio,
    horario_almoco_fim: assinatura.horario_almoco_fim,
    horario_fechamento: assinatura.horario_fechamento,
    whatsapp_status: assinatura.whatsapp_status,
    servicos: assinatura.servicos,
  });
});

app.get('/api/publico/assinaturas/:id/acesso', (req, res) => {
  const assinatura = obterAssinaturaPorId(req.params.id);

  if (!assinatura) {
    res.status(404).json({
      liberado: false,
      mensagem: 'Essa assinatura nao foi encontrada. Entre em contato com o suporte.',
    });
    return;
  }

  res.json({
    liberado: assinatura.status === 'ativo',
    mensagem:
      assinatura.status === 'ativo'
        ? ''
        : 'Atendimento temporariamente bloqueado. Regularize a assinatura para voltar a agendar.',
  });
});

app.get('/api/publico/assinaturas/:id/status', (req, res) => {
  const assinatura = obterAssinaturaPorId(req.params.id);

  if (!assinatura) {
    res.status(404).json({ error: 'Assinatura nao encontrada.' });
    return;
  }

  res.json({
    id: assinatura.id,
    status: assinatura.status,
    liberado: assinatura.status === 'ativo',
    metodoPagamento: assinatura.metodoPagamento || 'acesso_liberado',
  });
});

app.patch('/api/publico/assinaturas/:id', requireBarbeiro, (req, res) => {
  const {
    diasFuncionamento,
    horarioAbertura,
    horarioAlmocoInicio,
    horarioAlmocoFim,
    horarioFechamento,
    servicos,
  } = req.body;

  ACESSO_VITALICIO.dias_funcionamento = Array.isArray(diasFuncionamento)
    ? diasFuncionamento
    : ACESSO_VITALICIO.dias_funcionamento;
  ACESSO_VITALICIO.horario_abertura = horarioAbertura || ACESSO_VITALICIO.horario_abertura;
  ACESSO_VITALICIO.horario_almoco_inicio = horarioAlmocoInicio || ACESSO_VITALICIO.horario_almoco_inicio;
  ACESSO_VITALICIO.horario_almoco_fim = horarioAlmocoFim || ACESSO_VITALICIO.horario_almoco_fim;
  ACESSO_VITALICIO.horario_fechamento = horarioFechamento || ACESSO_VITALICIO.horario_fechamento;

  if (Array.isArray(servicos) && servicos.length) {
    ACESSO_VITALICIO.servicos = servicos.map((item, index) => ({
      id: index + 1,
      nome: item.nome,
      preco: Number(item.preco),
    }));
  }

  res.json({
    id: ACESSO_VITALICIO.id,
    dias_funcionamento: ACESSO_VITALICIO.dias_funcionamento,
    horario_abertura: ACESSO_VITALICIO.horario_abertura,
    horario_almoco_inicio: ACESSO_VITALICIO.horario_almoco_inicio,
    horario_almoco_fim: ACESSO_VITALICIO.horario_almoco_fim,
    horario_fechamento: ACESSO_VITALICIO.horario_fechamento,
    servicos: ACESSO_VITALICIO.servicos,
  });
});

app.post('/api/agendamentos', requireBarbeiroOuBridge, (req, res) => {
  const { cliente, telefone, servicoId, servicoNome, data, hora } = req.body;

  if (!cliente || !telefone || !data || !hora) {
    res.status(400).json({ error: 'Informe cliente, telefone, data e hora.' });
    return;
  }

  const servico = encontrarServicoPorIdOuNome(servicoId, servicoNome);

  if (!servico) {
    res.status(400).json({ error: 'Servico nao encontrado para este agendamento.' });
    return;
  }

  const conflito = demoAgendamentos.some(
    (item) => item.data === data && item.hora === hora && String(item.status || '').toLowerCase() === 'confirmado'
  );

  if (conflito) {
    res.status(409).json({ error: 'Esse horario acabou de ser reservado por outro cliente.' });
    return;
  }

  const agendamento = {
    id: Date.now(),
    cliente,
    telefone,
    servico: servico.nome,
    servico_id: servico.id,
    servico_preco: Number(servico.preco || 0),
    data,
    hora,
    status: 'confirmado',
    lembrete_15_enviado_em: null,
    lembrete_7_enviado_em: null,
  };

  demoAgendamentos.push(agendamento);
  res.status(201).json(agendamento);
});

app.post('/api/publico/assinaturas/:id/whatsapp/bridge-token', requireBarbeiro, (req, res) => {
  res.json({ token: 'demo-bridge-token' });
});

app.post('/api/agendamentos/:id/lembrete-15', (req, res) => {
  const id = Number(req.params.id);
  const agendamento = demoAgendamentos.find((item) => item.id === id);

  if (!agendamento) {
    res.status(404).json({ error: 'Agendamento nao encontrado.' });
    return;
  }

  agendamento.lembrete_15_enviado_em = req.body?.enviadoEm || new Date().toISOString();
  res.json({ ok: true });
});

app.post('/api/agendamentos/:id/lembrete-7', (req, res) => {
  const id = Number(req.params.id);
  const agendamento = demoAgendamentos.find((item) => item.id === id);

  if (!agendamento) {
    res.status(404).json({ error: 'Agendamento nao encontrado.' });
    return;
  }

  agendamento.lembrete_7_enviado_em = req.body?.enviadoEm || new Date().toISOString();
  res.json({ ok: true });
});

app.post('/api/barbeiro/logout', (req, res) => {
  const token = String(req.headers['x-barbeiro-token'] || '').trim();

  if (token) {
    barbeiroSessions.delete(token);
  }

  res.json({ ok: true });
});

app.post('/webhook', (req, res) => {
  if (req.body?.telefone || req.body?.phone || req.body?.from) {
    handleWhatsappWebhook({
      body: req.body,
      headers: req.headers,
    })
      .then((resultado) => {
        res.json(resultado);
      })
      .catch((error) => {
        res.status(400).json({ error: error.message });
      });
    return;
  }

  res.status(400).json({ error: 'Evento de WhatsApp invalido.' });
});

// Mantem as rotas legadas acima e expõe os endpoints novos do backend modular.
app.use(require('./services/httpErrors').createHttpErrorHandler());

const executorScope = require('./services/executionScope').executionScope;
const capabilityCoordinator = require('./services/executionCapabilities').coordinator;
executorScope.certifyProfile({ requiredCapabilities: ['listener.http', 'scheduler.outbox', 'scheduler.reminders', 'timer.evolution-cleanup'] });
let executorServer, executorOutbox, executorReminders, executorShutdown;
const shutdownExecutor = () => {
  if (executorShutdown) return executorShutdown;
  // Synchronous, irreversible local barrier, before any database await.
  require('./services/evolutionOwnershipOperation').stopExecutionAuthorization();
  const outboxClosing = executorOutbox?.stop();
  const remindersClosing = executorReminders?.stop();
  executorShutdown = Promise.all([outboxClosing, remindersClosing, capabilityCoordinator.drain()])
    .then(() => require('./database').close()).catch(() => { process.exitCode = 1; });
  return executorShutdown;
};
process.once('SIGTERM', shutdownExecutor);
process.once('SIGINT', shutdownExecutor);
supervision.current()?.onShutdown(shutdownExecutor);
executorScope.admit('startup.identity', async () => {
  await require('./database').ready;
  const supervised = supervision.current();
  if (supervised) {
    supervised.assertOpen();
    const identity = await supervised.confirmEnrollment();
    supervised.assertOpen(); executorScope.setExecutor(identity);
  } else await require('./services/executionLifecycle').initializeExecutor(require('./database').pool);
}).then(() => {
  executorScope.assertOpen();
  executorOutbox = require('./evolutionWebhook').startWorker();
  executorReminders = require('./services/reminders').startWorker(require('./database'));
  // The shared outbox worker materializes returns; migration 024 defaults delivery off.
  executorServer = app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    supervision.current()?.onReady(executorServer.address().port);
  });
  capabilityCoordinator.register('listener.http', () => new Promise((resolve, reject) => executorServer.close(error => error ? reject(error) : resolve())));
  executorServer.on('error', (erro) => registrarErroRuntime('serverError', erro));
}).catch(async (erro) => {
  console.error('Falha ao inicializar o banco de dados:', erro);
  process.exitCode = 1;
  await shutdownExecutor();
});
