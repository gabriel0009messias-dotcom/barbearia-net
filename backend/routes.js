const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');

require('./loadEnv');

const db = require('./database');
const {
  getEvolutionConfig,
  createEvolutionError,
  logEvolutionError,
  gerarNomeInstancia,
  extrairConteudoQr,
  construirQrCodeUrl,
  validarConexaoApi,
  confirmarExistenciaInstancia,
  extrairEstadoInstancia,
  criarInstancia,
  conectarInstancia,
  extrairPairingCode,
  obterEstadoConexao,
  tentativaConexaoAtiva,
  desconectarInstancia,
  configurarWebhookInstancia,
} = require('./evolutionApi');
const {
  iniciarSessao: iniciarSessaoWhatsappLocal,
  reiniciarSessao: reiniciarSessaoWhatsappLocal,
  statusSessao: statusSessaoWhatsappLocal,
} = require('./whatsappManager');
const { handleWhatsappWebhook } = require('./whatsappWebhook');
const { processarWebhookEvolution } = require('./evolutionWebhook');
const { logEvolution } = require('./evolutionLog');

const router = express.Router();
const DIAS_VENCIMENTO = [5, 12, 24];
const METODOS_PAGAMENTO = ['mercado_pago'];
// O painel legado usa "ativo"; mantemos "ativa" para registros antigos.
const STATUS_ASSINATURA = ['pendente', 'ativo', 'ativa', 'atrasada', 'bloqueado', 'bloqueada', 'cancelada', 'autorizada', 'pausada'];
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BARBER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const payments = require('./services/payments/mercadoPago');
const { PROFESSIONAL_PLAN, subscriptionPlan } = require('./services/payments/plan');
const VALOR_MENSAL_PADRAO = PROFESSIONAL_PLAN.amountCents / 100;
const TOLERANCIA_ATRASO_DIAS = 4;
const NOME_PLANO_PADRAO = PROFESSIONAL_PLAN.name;
const MENSAGEM_COMPROVANTE_WHATSAPP = 'Ola, regularizei a assinatura e preciso confirmar a liberacao do acesso.';
const MENSAGEM_COBRANCA_PADRAO = 'Sua assinatura esta em atraso. Regularize o pagamento para continuar usando o sistema.';
function obterPrimeiroEnvPreenchido(chaves = [], fallback = '') {
  for (const chave of chaves) {
    const valor = String(process.env[chave] || '').trim();

    if (valor) {
      return valor;
    }
  }

  return fallback;
}

const ADMIN_EMAIL = obterPrimeiroEnvPreenchido(['LEGACY_ADMIN_EMAIL', 'ADMIN_EMAIL', 'SUPER_ADMIN_EMAIL']);
const ADMIN_PASSWORD = obterPrimeiroEnvPreenchido(['LEGACY_ADMIN_PASSWORD', 'ADMIN_PASSWORD', 'SUPER_ADMIN_PASSWORD']);
const adminSessions = new Map();
const barberSessions = new Map();
const whatsappQrJobs = new Map();
const DIAS_SEMANA = [
  { value: 0, label: 'Domingo' },
  { value: 1, label: 'Segunda-feira' },
  { value: 2, label: 'Terca-feira' },
  { value: 3, label: 'Quarta-feira' },
  { value: 4, label: 'Quinta-feira' },
  { value: 5, label: 'Sexta-feira' },
  { value: 6, label: 'Sabado' },
];

function formatarDataISO(data) {
  return data.toISOString().slice(0, 10);
}

const deleteConfirmationKey = crypto.randomBytes(32);
function assinaturaDeleteToken(assinatura, adminToken) {
  return crypto.createHmac('sha256', deleteConfirmationKey)
    .update(JSON.stringify([assinatura.id, assinatura.created_at, adminToken])).digest('hex');
}

router.delete('/admin/assinaturas/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(id)) {
    return res.status(400).json({ error: 'Conta invalida. Atualize a lista e tente novamente.' });
  }
  try {
    const result = await db.transaction(async connection => {
      const assinatura = await connection.getAsync('SELECT id, created_at FROM assinaturas WHERE id=$1 FOR UPDATE', [id]);
      if (!assinatura) return 404;
      const supplied = req.body?.confirmationToken;
      const expected = assinaturaDeleteToken(assinatura, req.headers['x-admin-token']);
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return 409;
      // Explicit ownership filters also cover imported schemas without cascading FKs.
      for (const table of ['mercado_pago_payments', 'mercado_pago_orders', 'whatsapp_messages',
        'agendamentos', 'bloqueios', 'sessoes', 'password_reset_tokens', 'servicos_assinatura']) {
        await connection.runAsync(`DELETE FROM ${table} WHERE assinatura_id=$1`, [id]);
      }
      await connection.runAsync('DELETE FROM assinaturas WHERE id=$1', [id]);
      return 200;
    });
    if (result === 404) return res.status(404).json({ error: 'Conta nao encontrada. Atualize a lista.' });
    if (result === 409) return res.status(409).json({ error: 'A confirmacao nao corresponde a esta conta. Atualize a lista e confirme novamente.' });
    for (const [token, session] of barberSessions) {
      if (session.assinaturaId === id) barberSessions.delete(token);
    }
    res.json({ sucesso: true, id });
  } catch {
    res.status(500).json({ error: 'Nao foi possivel excluir a conta. Nenhuma exclusao foi concluida. Tente novamente.' });
  }
});

function criarDataLocal(data) {
  if (!data) {
    return null;
  }

  const [ano, mes, dia] = String(data)
    .slice(0, 10)
    .split('-')
    .map((item) => Number.parseInt(item, 10));

  if (!ano || !mes || !dia) {
    return null;
  }

  return new Date(ano, mes - 1, dia);
}

function calcularDiferencaEmDias(dataInicial, dataFinal) {
  const inicio = new Date(dataInicial.getFullYear(), dataInicial.getMonth(), dataInicial.getDate());
  const fim = new Date(dataFinal.getFullYear(), dataFinal.getMonth(), dataFinal.getDate());
  return Math.round((fim.getTime() - inicio.getTime()) / (24 * 60 * 60 * 1000));
}

function calcularProximoVencimento(diaVencimento, dataReferencia = new Date()) {
  const referencia = dataReferencia instanceof Date ? dataReferencia : criarDataLocal(dataReferencia) || new Date();
  const ano = referencia.getFullYear();
  const mes = referencia.getMonth();
  let vencimento = new Date(ano, mes, diaVencimento);

  if (referencia.getDate() >= diaVencimento) {
    vencimento = new Date(ano, mes + 1, diaVencimento);
  }

  return vencimento.toISOString().slice(0, 10);
}

function diasFuncionamentoPadrao() {
  return [1, 2, 3, 4, 5, 6];
}

function normalizarDiasFuncionamento(dias) {
  const lista = Array.isArray(dias)
    ? dias.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)
    : diasFuncionamentoPadrao();

  return Array.from(new Set(lista)).sort((a, b) => a - b);
}

function serializarDiasFuncionamento(dias) {
  return normalizarDiasFuncionamento(dias).join(',');
}

function desserializarDiasFuncionamento(valor) {
  if (!valor) {
    return diasFuncionamentoPadrao();
  }

  return normalizarDiasFuncionamento(
    String(valor)
      .split(',')
      .map((item) => item.trim())
  );
}

function mapearAssinatura(assinatura) {
  if (!assinatura) {
    return assinatura;
  }

  const statusAssinatura = String(assinatura.status_assinatura || assinatura.status || 'pendente').toUpperCase();
  const bloqueado = Number(assinatura.bloqueado || 0) === 1;

  return {
    ...assinatura,
    nome: assinatura.barbearia_nome,
    plano: assinatura.plano || NOME_PLANO_PADRAO,
    valor_plano: subscriptionPlan(assinatura).amountCents / 100,
    subscription_id: assinatura.subscription_id || assinatura.mercado_preapproval_id || null,
    customer_id: assinatura.customer_id || null,
    payment_id: assinatura.payment_id || null,
    status_assinatura: statusAssinatura,
    bloqueado,
    dias_atraso: Number(assinatura.dias_atraso || 0),
    data_bloqueio: assinatura.data_bloqueio || null,
    data_vencimento: assinatura.proximo_vencimento,
    data_ultimo_pagamento: assinatura.ultimo_pagamento,
    observacao: assinatura.observacoes || '',
    dias_funcionamento: desserializarDiasFuncionamento(assinatura.dias_funcionamento),
    localizacao_cidade: String(assinatura.localizacao_cidade || '').trim(),
    localizacao_rua: String(assinatura.localizacao_rua || '').trim(),
    localizacao_referencia: String(assinatura.localizacao_referencia || '').trim(),
  };
}

function normalizarTelefoneWhatsApp(numero = '') {
  const digitos = String(numero || '').replace(/\D/g, '');

  if (!digitos) {
    return '';
  }

  if (digitos.startsWith('55')) {
    return digitos;
  }

  return `55${digitos}`;
}

function criarLinkWhatsApp(numero, mensagem) {
  const telefone = normalizarTelefoneWhatsApp(numero);

  if (!telefone) {
    return null;
  }

  return `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;
}

function acessoManualAtivo(assinatura) {
  return Date.parse(assinatura?.acesso_manual_ate || '') > Date.now();
}

function calcularResumoPagamento(assinatura) {
  if (acessoManualAtivo(assinatura)) {
    return {
      diasAtraso: 0, atrasado: false, venceHoje: false, bloqueiaHoje: false,
      bloqueado: false, statusSugerido: 'ativa', statusAssinaturaSugerido: 'ATIVA',
      indicadorAtraso: 'Acesso liberado pelo administrador',
      mensagemAdmin: 'Acesso temporario sem confirmacao de pagamento.',
      mensagemCliente: 'Seu acesso temporario esta liberado.',
    };
  }
  if (!assinatura?.proximo_vencimento) {
    return {
      diasAtraso: 0,
      atrasado: false,
      venceHoje: false,
      bloqueiaHoje: false,
      statusSugerido: assinatura?.status || 'pendente',
      statusAssinaturaSugerido: assinatura?.status_assinatura || 'PENDENTE',
      bloqueado: Number(assinatura?.bloqueado || 0) === 1,
      indicadorAtraso: 'Sem vencimento definido',
      mensagemAdmin: 'Sem vencimento definido.',
      mensagemCliente: 'Pagamento pendente. Conclua a assinatura para liberar o sistema.',
    };
  }

  const hoje = new Date();
  const vencimento = criarDataLocal(assinatura.proximo_vencimento);

  if (!vencimento) {
    return {
      diasAtraso: 0,
      atrasado: false,
      venceHoje: false,
      bloqueiaHoje: false,
      statusSugerido: assinatura.status,
      statusAssinaturaSugerido: assinatura.status_assinatura || 'PENDENTE',
      bloqueado: Number(assinatura?.bloqueado || 0) === 1,
      indicadorAtraso: 'Data invalida',
      mensagemAdmin: 'Data de vencimento invalida.',
      mensagemCliente: 'Nao foi possivel verificar o vencimento da assinatura.',
    };
  }

  const diasAtraso = Math.max(0, calcularDiferencaEmDias(vencimento, hoje));
  const diasParaVencer = calcularDiferencaEmDias(hoje, vencimento);
  const atrasado = diasAtraso > 0;
  const venceHoje = diasParaVencer === 0;
  const bloqueiaHoje = diasAtraso === TOLERANCIA_ATRASO_DIAS;
  const bloqueadoAutomatico = diasAtraso > TOLERANCIA_ATRASO_DIAS;
  const statusGateway = String(assinatura.gateway_status || '').toLowerCase();
  const cancelada = ['cancelled', 'canceled'].includes(statusGateway) || String(assinatura.status_assinatura || '').toUpperCase() === 'CANCELADA';

  let statusSugerido = assinatura.status;
  let statusAssinaturaSugerido = String(assinatura.status_assinatura || '').toUpperCase() || 'PENDENTE';
  let bloqueado = Number(assinatura.bloqueado || 0) === 1;

  if (cancelada) {
    statusSugerido = 'cancelada';
    statusAssinaturaSugerido = 'CANCELADA';
    bloqueado = true;
  } else if (String(assinatura.status || '').toLowerCase() === 'ativa' || String(assinatura.status || '').toLowerCase() === 'ativo') {
    if (bloqueadoAutomatico) {
      statusSugerido = 'bloqueada';
      statusAssinaturaSugerido = 'BLOQUEADA';
      bloqueado = true;
    } else if (atrasado || venceHoje) {
      statusSugerido = 'atrasada';
      statusAssinaturaSugerido = 'ATRASADA';
      bloqueado = false;
    } else {
      statusSugerido = 'ativa';
      statusAssinaturaSugerido = 'ATIVA';
      bloqueado = false;
    }
  } else if (bloqueadoAutomatico) {
    statusSugerido = 'bloqueada';
    statusAssinaturaSugerido = 'BLOQUEADA';
    bloqueado = true;
  }

  let indicadorAtraso = 'Em dia';
  let mensagemAdmin = 'Pagamento em dia.';
  let mensagemCliente = 'Seu acesso esta ativo.';

  if (cancelada) {
    indicadorAtraso = 'Cancelada';
    mensagemAdmin = 'Assinatura cancelada no Mercado Pago.';
    mensagemCliente = 'Sua assinatura foi cancelada. Regularize para voltar a usar o sistema.';
  } else if (bloqueadoAutomatico) {
    indicadorAtraso = `${diasAtraso} dias atrasado`;
    mensagemAdmin = `Pagamento atrasado ha ${diasAtraso} dias. O sistema deve permanecer bloqueado.`;
    mensagemCliente = 'Sua assinatura esta em atraso. Regularize o pagamento para voltar a usar o sistema.';
  } else if (bloqueiaHoje) {
    indicadorAtraso = '4 dias (bloquear hoje)';
    mensagemAdmin = 'Cliente no ultimo dia de tolerancia. Se o Mercado Pago nao aprovar, o bloqueio acontece hoje.';
    mensagemCliente = 'Sua assinatura esta no ultimo dia de tolerancia. Regularize hoje para evitar o bloqueio.';
  } else if (diasAtraso === 2) {
    indicadorAtraso = '2 dias atrasado';
    mensagemAdmin = 'Cliente com 2 dias de atraso.';
    mensagemCliente = 'Seu pagamento esta com 2 dias de atraso. Regularize para evitar bloqueio.';
  } else if (diasAtraso === 1) {
    indicadorAtraso = '1 dia atrasado';
    mensagemAdmin = 'Cliente com 1 dia de atraso.';
    mensagemCliente = 'Seu pagamento esta com 1 dia de atraso. Regularize para evitar bloqueio.';
  } else if (venceHoje) {
    indicadorAtraso = 'Vence hoje';
    mensagemAdmin = 'Pagamento vence hoje. Status deve ficar pendente ate a confirmacao do Mercado Pago.';
    mensagemCliente = 'Seu pagamento vence hoje.';
  } else if (diasParaVencer > 0 && diasParaVencer <= 3) {
    indicadorAtraso = `Vence em ${diasParaVencer} dia${diasParaVencer === 1 ? '' : 's'}`;
    mensagemAdmin = `Pagamento vence em ${diasParaVencer} dia${diasParaVencer === 1 ? '' : 's'}.`;
    mensagemCliente = `Seu pagamento vence em ${diasParaVencer} dia${diasParaVencer === 1 ? '' : 's'}.`;
  }

  return {
    diasAtraso,
    diasParaVencer,
    atrasado,
    venceHoje,
    bloqueiaHoje,
    bloqueadoAutomatico,
    statusSugerido,
    statusAssinaturaSugerido,
    bloqueado,
    indicadorAtraso,
    mensagemAdmin,
    mensagemCliente,
  };
}

function criarLembretePagamento(assinatura) {
  const resumo = calcularResumoPagamento(assinatura);

  if (resumo.statusSugerido === 'ativo' && !resumo.venceHoje && !resumo.atrasado && resumo.diasParaVencer > 3) {
    return null;
  }

  return {
    tipo: resumo.statusSugerido === 'bloqueado' ? 'bloqueado' : resumo.atrasado ? 'atrasado' : resumo.venceHoje ? 'hoje' : 'proximo',
    diasAtraso: resumo.diasAtraso,
    diasParaVencer: resumo.diasParaVencer,
    indicador: resumo.indicadorAtraso,
    mensagem: resumo.mensagemCliente,
  };
}

async function sincronizarStatusPorVencimento(assinatura) {
  // Temporary access is projected in responses; billing state stays unchanged in storage.
  if (acessoManualAtivo(assinatura)) {
    return { ...assinatura, status: 'ativa', status_assinatura: 'ATIVA', bloqueado: 0 };
  }
  if (!assinatura || !assinatura.proximo_vencimento) {
    return assinatura;
  }

  const resumo = calcularResumoPagamento(assinatura);

  if (
    resumo.statusSugerido !== assinatura.status ||
    resumo.statusAssinaturaSugerido !== String(assinatura.status_assinatura || '').toUpperCase() ||
    Number(assinatura.dias_atraso || 0) !== resumo.diasAtraso ||
    Number(assinatura.bloqueado || 0) !== (resumo.bloqueado ? 1 : 0)
  ) {
    await runAsync(
      `UPDATE assinaturas
       SET status = $1,
           status_assinatura = $2,
           dias_atraso = $3,
           bloqueado = $4,
           data_bloqueio = CASE
             WHEN $5 = 1 AND data_bloqueio IS NULL THEN CURRENT_TIMESTAMP::text
             WHEN $6 = 0 THEN NULL
             ELSE data_bloqueio
           END,
           data_vencimento = COALESCE(proximo_vencimento, data_vencimento),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7`,
      [
        resumo.statusSugerido,
        resumo.statusAssinaturaSugerido,
        resumo.diasAtraso,
        resumo.bloqueado ? 1 : 0,
        resumo.bloqueado ? 1 : 0,
        resumo.bloqueado ? 1 : 0,
        assinatura.id,
      ]
    );

    return getAsync("SELECT * FROM assinaturas WHERE id = $1", [assinatura.id]);
  }

  return assinatura;
}

async function enriquecerAssinatura(assinatura) {
  const sincronizada = await sincronizarStatusPorVencimento(assinatura);

  if (!sincronizada) {
    return sincronizada;
  }

  const resumoPagamento = calcularResumoPagamento(sincronizada);
  const pix = null;

  return {
    ...mapearAssinatura(sincronizada),
    pix,
    atraso: {
      dias: resumoPagamento.diasAtraso,
      indicador: resumoPagamento.indicadorAtraso,
      bloqueiaHoje: resumoPagamento.bloqueiaHoje,
    },
    cobranca: {
      mensagem: MENSAGEM_COBRANCA_PADRAO,
      whatsappLink: criarLinkWhatsApp(sincronizada.suporte_numero, MENSAGEM_COMPROVANTE_WHATSAPP),
      lembreteLink: criarLinkWhatsApp(sincronizada.telefone || sincronizada.whatsapp_numero, MENSAGEM_COBRANCA_PADRAO),
    },
    lembrete_pagamento: criarLembretePagamento(sincronizada),
  };
}

async function carregarAssinaturaAtualizada(id) {
  const assinatura = await getAsync("SELECT * FROM assinaturas WHERE id = $1", [id]);
  return sincronizarStatusPorVencimento(assinatura);
}

function avaliarAcessoAssinatura(assinatura) {
  if (!assinatura) {
    return {
      liberado: false,
      motivo: 'nao_encontrada',
      mensagem: 'Assinatura nao encontrada.',
    };
  }

  const resumo = calcularResumoPagamento(assinatura);

  if (assinatura.bloqueado || assinatura.status === 'bloqueada' || assinatura.status === 'cancelada') {
    return {
      liberado: false,
      motivo: 'bloqueado',
      mensagem: resumo.mensagemCliente,
    };
  }

  if (assinatura.status === 'ativa' || assinatura.status === 'ativo') {
    return {
      liberado: true,
      motivo: 'assinatura_ativa',
      mensagem: 'Assinatura ativa.',
    };
  }

  if (assinatura.status === 'atrasada') {
    return {
      liberado: true,
      motivo: 'grace_period',
      mensagem: resumo.mensagemCliente,
    };
  }

  if (assinatura.status === 'teste' || assinatura.status === 'pendente' || assinatura.status === 'autorizada' || assinatura.status === 'pausada') {
    return {
      liberado: false,
      motivo: 'pagamento_pendente',
      mensagem: 'Cadastro concluido. Finalize a assinatura para liberar o sistema.',
    };
  }

  return {
    liberado: false,
    motivo: 'bloqueado',
    mensagem: resumo.mensagemCliente,
  };
}

function montarEstadoPagamento(assinatura) {
  const resumo = calcularResumoPagamento(assinatura);
  const acesso = avaliarAcessoAssinatura(assinatura);

  return {
    id: assinatura.id,
    status: assinatura.status,
    statusAssinatura: String(assinatura.status_assinatura || assinatura.status || 'PENDENTE').toUpperCase(),
    liberado: acesso.liberado,
    motivo: acesso.motivo,
    mensagem: acesso.mensagem,
    atraso: {
      dias: resumo.diasAtraso,
      indicador: resumo.indicadorAtraso,
      bloqueiaHoje: resumo.bloqueiaHoje,
    },
    bloqueado: resumo.bloqueado,
    plano: assinatura.plano || NOME_PLANO_PADRAO,
    valor: subscriptionPlan(assinatura).amountCents / 100,
    gatewayCheckoutUrl: assinatura.gateway_checkout_url || null,
    gatewayProvider: assinatura.gateway_provider || 'mercado_pago',
    mensagemCobranca: MENSAGEM_COBRANCA_PADRAO,
    whatsappLink: criarLinkWhatsApp(assinatura.suporte_numero, MENSAGEM_COMPROVANTE_WHATSAPP),
  };
}

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve(this);
    });
  });
}

function gerarSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function gerarHashSenha(senha, salt) {
  return crypto.scryptSync(String(senha), salt, 64).toString('hex');
}

function criarCredenciaisSenha(senha) {
  const salt = gerarSalt();
  return {
    salt,
    hash: gerarHashSenha(senha, salt),
  };
}

function verificarSenha(senha, assinatura) {
  if (!assinatura?.senha_hash || !assinatura?.senha_salt) {
    return false;
  }

  const hashCalculado = Buffer.from(gerarHashSenha(senha, assinatura.senha_salt), 'hex');
  const hashSalvo = Buffer.from(assinatura.senha_hash, 'hex');

  if (hashCalculado.length !== hashSalvo.length) {
    return false;
  }

  return crypto.timingSafeEqual(hashCalculado, hashSalvo);
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

async function getConfiguracao(chave) {
  const row = await getAsync("SELECT valor FROM configuracoes WHERE chave = $1", [chave]);
  return row?.valor || '';
}

function limparSessoesAdminExpiradas() {
  const agora = Date.now();

  for (const [token, expiresAt] of adminSessions.entries()) {
    if (expiresAt <= agora) {
      adminSessions.delete(token);
    }
  }
}

function requireAdmin(req, res, next) {
  limparSessoesAdminExpiradas();

  const token = req.headers['x-admin-token'];

  if (!token || !adminSessions.has(token)) {
    res.status(401).json({ error: 'Acesso admin nao autorizado.' });
    return;
  }

  next();
}

function limparSessoesBarbeiroExpiradas() {
  const agora = Date.now();

  for (const [token, session] of barberSessions.entries()) {
    if (!session?.expiresAt || session.expiresAt <= agora) {
      barberSessions.delete(token);
    }
  }
}

async function carregarAssinaturaPorToken(token) {
  limparSessoesBarbeiroExpiradas();

  if (!token || !barberSessions.has(token)) {
    return null;
  }

  const session = barberSessions.get(token);
  const assinaturaOriginal = await getAsync("SELECT * FROM assinaturas WHERE id = $1", [session.assinaturaId]);
  const assinatura = await sincronizarStatusPorVencimento(assinaturaOriginal);

  if (!assinatura) {
    barberSessions.delete(token);
    return null;
  }

  const acesso = avaliarAcessoAssinatura(assinatura);

  if (!acesso.liberado) {
    barberSessions.delete(token);

    const error = new Error(acesso.mensagem);
    error.statusCode = 403;
    error.assinatura = assinatura;
    throw error;
  }

  return assinatura;
}

async function carregarAssinaturaPorBridgeToken(token) {
  if (!token) {
    return null;
  }

  const assinaturaOriginal = await getAsync("SELECT * FROM assinaturas WHERE whatsapp_bridge_token = $1", [token]);
  const assinatura = await sincronizarStatusPorVencimento(assinaturaOriginal);

  if (!assinatura) {
    return null;
  }

  const acesso = avaliarAcessoAssinatura(assinatura);

  if (!acesso.liberado) {
    const error = new Error(acesso.mensagem);
    error.statusCode = 403;
    error.assinatura = assinatura;
    throw error;
  }

  return assinatura;
}

async function requireBarbeiro(req, res, next) {
  try {
    const token = req.headers['x-barbeiro-token'];
    const assinatura = await carregarAssinaturaPorToken(token);
    if (!assinatura) {
      if (req.path.includes('/whatsapp/')) {
        console.info('[WHATSAPP] Consulta sem login valido', { assinaturaId: req.params.id });
        return responderErroWhatsapp(res, createEvolutionError('Sua sessao expirou. Entre novamente no painel.', 401, 'WHATSAPP_AUTH_REQUIRED'));
      }
      return res.status(401).json({ error: 'Login do barbeiro obrigatorio.' });
    }
    req.barbeiroToken = token;
    req.assinatura = assinatura;
    next();
  } catch (error) {
    if (req.path.includes('/whatsapp/')) {
      logEvolutionError('autenticacao da assinatura no WhatsApp', error);
      return responderErroWhatsapp(res, error);
    }
    const payload = { error: error.message };
    if (error.assinatura) Object.assign(payload, montarEstadoPagamento(error.assinatura));
    res.status(error.statusCode || 500).json(payload);
  }
}

async function requirePainelOuBridge(req, res, next) {
  try {
    const barberToken = req.headers['x-barbeiro-token'];
    const bridgeToken = req.headers['x-whatsapp-bridge-token'];
    const assinatura = barberToken
      ? await carregarAssinaturaPorToken(barberToken)
      : await carregarAssinaturaPorBridgeToken(bridgeToken);

    if (!assinatura) {
      res.status(401).json({ error: 'Acesso da assinatura nao autorizado.' });
      return;
    }

    req.barbeiroToken = barberToken || null;
    req.whatsappBridgeToken = bridgeToken || null;
    req.assinatura = assinatura;
    next();
  } catch (error) {
    const payload = { error: error.message };

    if (error.assinatura) {
      Object.assign(payload, montarEstadoPagamento(error.assinatura));
    }

    res.status(error.statusCode || 500).json(payload);
  }
}

async function listarServicosDaAssinatura(assinaturaId) {
  return allAsync(
    `SELECT id, nome, preco
     FROM servicos_assinatura
     WHERE assinatura_id = $1
     ORDER BY id ASC`,
    [assinaturaId]
  );
}

async function listarAssinaturasComServicos() {
  const assinaturas = await allAsync(
    `SELECT s.*, (EXISTS (
       SELECT 1 FROM mercado_pago_payments p
       WHERE p.assinatura_id=s.id AND p.status='approved' AND p.credited_at IS NOT NULL
     )
     OR (
       s.gateway_status='approved'
       AND NULLIF(BTRIM(s.payment_id), '') IS NOT NULL
       AND NULLIF(BTRIM(s.ultimo_pagamento), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM mercado_pago_payments p WHERE p.assinatura_id=s.id AND p.payment_id=s.payment_id
       )
     )) AS pagamento_aprovado_confirmado
     FROM assinaturas s
      ORDER BY
       CASE status
         WHEN 'bloqueado' THEN 0
         WHEN 'pendente' THEN 1
         WHEN 'teste' THEN 1
         ELSE 3
       END,
       proximo_vencimento ASC,
       created_at DESC`
  );

  const admitidas = [];
  const pendentes = [];
  for (const { pagamento_aprovado_confirmado, ...assinatura } of assinaturas) {
    if (pagamento_aprovado_confirmado || acessoManualAtivo(assinatura)) {
      admitidas.push(assinatura);
    } else {
      // Showing a pending registration must not change its access or billing state.
      const { id, barbearia_nome, responsavel_nome, email, telefone, whatsapp_numero, metodo_pagamento, created_at } = assinatura;
      pendentes.push({ id, barbearia_nome, responsavel_nome, email, telefone, whatsapp_numero, metodo_pagamento, created_at,
        status: 'aguardando_pagamento' });
    }
  }
  const detalhadas = await Promise.all(
    admitidas.map(async (assinatura) => {
      const enriquecida = await enriquecerAssinatura(assinatura);

      return {
        ...enriquecida,
        servicos: await listarServicosDaAssinatura(assinatura.id),
      };
    })
  );

  return { assinaturas: detalhadas, pendentes };
}

async function montarRespostaAssinatura(assinaturaId) {
  const assinatura = await getAsync("SELECT * FROM assinaturas WHERE id = $1", [assinaturaId]);

  return {
    ...(await enriquecerAssinatura(assinatura)),
    servicos: await listarServicosDaAssinatura(assinaturaId),
  };
}

async function obterOuCriarServicoPadrao(nome, preco) {
  const nomeNormalizado = String(nome || '').trim();
  const precoNormalizado = Number(preco);

  if (!nomeNormalizado || !Number.isFinite(precoNormalizado) || precoNormalizado <= 0) {
    throw new Error('Servico invalido para criar o agendamento.');
  }

  const servicoExistente = await getAsync(
    "SELECT id FROM servicos WHERE nome = $1 AND preco = $2 ORDER BY id ASC LIMIT 1",
    [nomeNormalizado, precoNormalizado]
  );

  if (servicoExistente?.id) {
    return servicoExistente.id;
  }

  const result = await runAsync('INSERT INTO servicos (nome, preco) VALUES ($1, $2)', [nomeNormalizado, precoNormalizado]);
  return result.lastID;
}

async function buscarServicoDaAssinatura(assinaturaId, servicoId, servicoNome, servicoPreco) {
  const idNumerico = Number(servicoId);

  if (Number.isInteger(idNumerico) && idNumerico > 0) {
    const servicoAssinatura = await getAsync(
      `SELECT id, nome, preco
       FROM servicos_assinatura
       WHERE assinatura_id = $1
         AND id = $2`,
      [assinaturaId, idNumerico]
    );

    if (servicoAssinatura) {
      return servicoAssinatura;
    }
  }

  const nomeNormalizado = String(servicoNome || '').trim();
  const precoNormalizado = Number(servicoPreco);

  if (!nomeNormalizado || !Number.isFinite(precoNormalizado) || precoNormalizado <= 0) {
    return null;
  }

  const servicoPorNome = await getAsync(
    `SELECT id, nome, preco
     FROM servicos_assinatura
     WHERE assinatura_id = $1
       AND lower(nome) = lower($2)
     ORDER BY id ASC
     LIMIT 1`,
    [assinaturaId, nomeNormalizado]
  );

  if (servicoPorNome) {
    return {
      ...servicoPorNome,
      preco: Number(servicoPorNome.preco || precoNormalizado),
    };
  }

  return {
    id: null,
    nome: nomeNormalizado,
    preco: precoNormalizado,
  };
}

function criarSessaoBarbeiro(assinaturaId) {
  const token = crypto.randomBytes(24).toString('hex');
  barberSessions.set(token, {
    assinaturaId,
    expiresAt: Date.now() + BARBER_SESSION_TTL_MS,
  });
  return token;
}

function normalizarIdentificador(identificador = '') {
  return String(identificador).trim();
}

function normalizarEmail(email = '') {
  return String(email || '').trim().toLowerCase();
}

function criarTokenRecuperacao() {
  return crypto.randomBytes(32).toString('hex');
}

function gerarHashTokenRecuperacao(token = '') {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function calcularExpiracaoRecuperacao(minutos = 60) {
  return new Date(Date.now() + minutos * 60 * 1000).toISOString();
}

function criarTransporteEmail() {
  const gmailUser = String(process.env.GMAIL_USER || '').trim();
  const gmailPassword = String(process.env.GMAIL_APP_PASSWORD || '').trim();
  const gmailPort = Number(process.env.GMAIL_PORT || 587);
  const gmailSecure = String(process.env.GMAIL_SECURE || '').trim() === 'true' || gmailPort === 465;
  const smtpHost = String(process.env.SMTP_HOST || '').trim();
  const smtpUser = String(process.env.SMTP_USER || '').trim();
  const smtpPass = String(process.env.SMTP_PASS || '').trim();

  if (gmailUser && gmailPassword) {
    return {
      from: String(process.env.GMAIL_FROM || gmailUser).trim(),
      transport: nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: gmailPort,
        secure: gmailSecure,
        requireTLS: !gmailSecure,
        connectionTimeout: Number(process.env.EMAIL_CONNECTION_TIMEOUT || 15000),
        greetingTimeout: Number(process.env.EMAIL_GREETING_TIMEOUT || 15000),
        socketTimeout: Number(process.env.EMAIL_SOCKET_TIMEOUT || 20000),
        auth: {
          user: gmailUser,
          pass: gmailPassword,
        },
      }),
    };
  }

  if (smtpHost && smtpUser && smtpPass) {
    return {
      from: String(process.env.SMTP_FROM || smtpUser).trim(),
      transport: nodemailer.createTransport({
        host: smtpHost,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || '').trim() === 'true',
        connectionTimeout: Number(process.env.EMAIL_CONNECTION_TIMEOUT || 15000),
        greetingTimeout: Number(process.env.EMAIL_GREETING_TIMEOUT || 15000),
        socketTimeout: Number(process.env.EMAIL_SOCKET_TIMEOUT || 20000),
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      }),
    };
  }

  return null;
}

function criarProvedorEmailApi() {
  const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();
  const brevoApiKey = String(process.env.BREVO_API_KEY || process.env.SENDINBLUE_API_KEY || '').trim();
  const from = String(
    process.env.EMAIL_FROM ||
      process.env.GMAIL_FROM ||
      process.env.SMTP_FROM ||
      process.env.GMAIL_USER ||
      process.env.SMTP_USER ||
      ''
  ).trim();
  const fromName = String(process.env.EMAIL_FROM_NAME || 'Salaoflix').trim();

  if (resendApiKey && from) {
    return { provider: 'resend', apiKey: resendApiKey, from, fromName };
  }

  if (brevoApiKey && from) {
    return { provider: 'brevo', apiKey: brevoApiKey, from, fromName };
  }

  return null;
}

function emailRecuperacaoConfigurado() {
  return Boolean(criarProvedorEmailApi() || criarTransporteEmail());
}

function smtpProvavelmenteBloqueadoNaHospedagem() {
  return emAmbienteHospedado() && !criarProvedorEmailApi() && Boolean(criarTransporteEmail());
}

function criarErroConfiguracaoEmailHospedado() {
  const error = new Error(
    'Este servidor hospedado nao consegue enviar recuperacao por SMTP do Gmail. Configure RESEND_API_KEY ou BREVO_API_KEY nas variaveis do servidor para liberar o envio de e-mail.'
  );
  error.statusCode = 503;
  return error;
}

function emAmbienteHospedado() {
  return Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
}

function credenciaisAdminConfiguradas() {
  return Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);
}

function usarEvolutionWhatsapp() {
  const evolution = getEvolutionConfig();
  return Boolean(evolution.enabled || emAmbienteHospedado());
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(timeoutMessage);
      error.statusCode = 504;
      reject(error);
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enviarEmailPorApi(config, payload) {
  if (config.provider === 'resend') {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${config.fromName} <${config.from}>`,
        to: [payload.to],
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(body?.message || body?.error || 'Falha ao enviar e-mail pela API.');
      error.statusCode = response.status || 502;
      throw error;
    }

    return {
      messageId: body?.id || null,
      accepted: [payload.to],
      rejected: [],
      response: 'resend',
    };
  }

  if (config.provider === 'brevo') {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: {
          name: config.fromName,
          email: config.from,
        },
        to: [{ email: payload.to }],
        subject: payload.subject,
        textContent: payload.text,
        htmlContent: payload.html,
      }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(body?.message || body?.code || body?.error || 'Falha ao enviar e-mail pela API.');
      error.statusCode = response.status || 502;
      throw error;
    }

    return {
      messageId: body?.messageId || null,
      accepted: [payload.to],
      rejected: [],
      response: 'brevo',
    };
  }

  throw new Error('Provedor de e-mail por API nao suportado.');
}

async function enviarEmail(payload) {
  const apiConfig = criarProvedorEmailApi();

  if (apiConfig) {
    return withTimeout(
      enviarEmailPorApi(apiConfig, payload),
      Number(process.env.EMAIL_SEND_TIMEOUT || 25000),
      'O servidor demorou demais para enviar o e-mail de recuperacao.'
    );
  }

  const smtpConfig = criarTransporteEmail();

  if (!smtpConfig) {
    const error = new Error(
      'Recuperacao por e-mail ainda nao esta configurada neste servidor. Adicione RESEND_API_KEY, BREVO_API_KEY ou credenciais SMTP.'
    );
    error.statusCode = 501;
    throw error;
  }

  if (smtpProvavelmenteBloqueadoNaHospedagem()) {
    throw criarErroConfiguracaoEmailHospedado();
  }

  return withTimeout(
    smtpConfig.transport.sendMail({
      from: smtpConfig.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    }),
    Number(process.env.EMAIL_SEND_TIMEOUT || 25000),
    'O servidor demorou demais para enviar o e-mail de recuperacao.'
  );
}

async function enviarCodigoRecuperacaoPorEmail(destino, codigo) {
  const email = String(destino || '').trim();

  if (!email) {
    throw new Error('Essa barbearia nao possui Gmail valido para recuperar a senha.');
  }

  await enviarEmail({
    to: email,
    subject: 'Codigo de recuperacao do Salãoflix',
    text: `Codigo de recuperacao do Salãoflix: ${codigo}\n\nEsse codigo vale por 15 minutos. Se voce nao pediu essa troca, ignore esta mensagem.`,
    html: `<p>Codigo de recuperacao do Salãoflix: <strong>${codigo}</strong></p><p>Esse codigo vale por 15 minutos. Se voce nao pediu essa troca, ignore esta mensagem.</p>`,
  });
}

function getPublicAppUrl(req) {
  const configuredUrl = String(process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim();

  if (configuredUrl) {
    return configuredUrl.replace(/\/$/, '');
  }

  const forwardedProto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const forwardedHost = String(req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();

  const host = forwardedHost.replace(/\/$/, '');
  const hostNormalizado = host.toLowerCase();
  const ehHostLocal =
    hostNormalizado === 'localhost' ||
    hostNormalizado.startsWith('localhost:') ||
    hostNormalizado === '127.0.0.1' ||
    hostNormalizado.startsWith('127.0.0.1:');

  if (emAmbienteHospedado() && ehHostLocal) {
    throw Object.assign(
      new Error('PUBLIC_APP_URL nao configurada no servidor para montar o link de recuperacao.'),
      { statusCode: 500 }
    );
  }

  return `${forwardedProto || 'https'}://${host}`.replace(/\/$/, '');
}

async function buscarAssinaturaPorEmailRecuperacao(email) {
  return getAsync(
    `SELECT *
     FROM assinaturas
     WHERE lower(email) = $1
     ORDER BY id DESC
     LIMIT 1`,
    [normalizarEmail(email)]
  );
}

function gerarHashTokenRecuperacaoSeguro(token = '') {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function criarTokenRecuperacaoSeguro() {
  return crypto.randomBytes(32).toString('hex');
}

function calcularExpiracaoRecuperacaoSenha(minutos = 60) {
  return new Date(Date.now() + minutos * 60 * 1000).toISOString();
}

async function salvarTokenRecuperacaoSenha(assinaturaId, tokenHash, expiresAt) {
  await runAsync("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE assinatura_id = $1 AND used_at IS NULL", [
    assinaturaId,
  ]);

  await runAsync(
    `INSERT INTO password_reset_tokens (assinatura_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [assinaturaId, tokenHash, expiresAt]
  );
}

async function carregarTokenRecuperacaoSenha(token) {
  return getAsync(
    `SELECT
       prt.id,
       prt.assinatura_id,
       prt.expires_at,
       prt.used_at,
       a.email
     FROM password_reset_tokens prt
     JOIN assinaturas a ON a.id = prt.assinatura_id
     WHERE prt.token_hash = $1
       AND prt.used_at IS NULL
     LIMIT 1`,
    [gerarHashTokenRecuperacaoSeguro(token)]
  );
}

async function enviarLinkRecuperacaoPorEmailSeguro(destino, linkRecuperacao) {
  const email = String(destino || '').trim();
  const apiConfig = criarProvedorEmailApi();
  const smtpConfig = criarTransporteEmail();
  const from = apiConfig?.from || smtpConfig?.from || null;

  if (!email) {
    throw new Error('Essa barbearia nao possui Gmail valido para recuperar a senha.');
  }

  if (!apiConfig && !smtpConfig) {
    const error = new Error(
      'Recuperacao por e-mail ainda nao esta configurada neste servidor. Adicione RESEND_API_KEY, BREVO_API_KEY ou credenciais SMTP.'
    );
    error.statusCode = 501;
    throw error;
  }

  console.info('[recuperacao-email] iniciando envio', {
    to: email,
    from,
    hosted: emAmbienteHospedado(),
    provider: apiConfig?.provider || 'smtp',
  });

  const info = await enviarEmail({
    to: email,
    subject: 'Recuperacao de senha do Salaoflix',
    text:
      `Clique no link abaixo para redefinir sua senha:\n\n${linkRecuperacao}\n\n` +
      'Esse link expira em 60 minutos. Se voce nao pediu essa troca, ignore este e-mail.',
    html:
      `<p>Clique no link abaixo para redefinir sua senha:</p>` +
      `<p><a href="${linkRecuperacao}">${linkRecuperacao}</a></p>` +
      '<p>Esse link expira em 60 minutos. Se voce nao pediu essa troca, ignore este e-mail.</p>',
  });

  console.info('[recuperacao-email] envio concluido', {
    to: email,
    messageId: info?.messageId || null,
    accepted: Array.isArray(info?.accepted) ? info.accepted : [],
    rejected: Array.isArray(info?.rejected) ? info.rejected : [],
    response: info?.response || null,
  });
}

function erroHorarioJaOcupado(error) {
  return error?.code === '23505' || /unique|constraint/i.test(String(error?.message || ''));
}

function assinaturaPertenceAoBarbeiro(req, res) {
  if (Number(req.params.id) !== Number(req.assinatura.id)) {
    res.status(403).json({ success: false, status: 'error', connected: false, message: 'Essa assinatura nao pertence a este login.', error: 'Essa assinatura nao pertence a este login.' });
    return false;
  }

  return true;
}

function mapearStatusWhatsappEvolution(state = '') {
  const estado = String(state || '').trim().toLowerCase();

  if (['open', 'connected'].includes(estado)) {
    return 'conectado';
  }

  if (['connecting', 'pairing', 'syncing'].includes(estado)) {
    return 'iniciando';
  }

  if (['close', 'closed', 'disconnected', 'logout'].includes(estado)) {
    return 'nao_configurado';
  }

  return estado || 'nao_configurado';
}

function respostaStatusWhatsapp({
  status = 'nao_configurado',
  qrCode = null,
  qr = null,
  ultimoErro = null,
  instancia = null,
  conectado = false,
  precisaQr = false,
  mensagem = '',
} = {}) {
  return {
    success: !['error', 'erro'].includes(status),
    connected: Boolean(conectado),
    message: mensagem || ultimoErro || '',
    status,
    qrCode,
    qr,
    ultimoErro,
    instancia,
    conectado: Boolean(conectado),
    precisaQr: Boolean(precisaQr),
    mensagem,
  };
}

function mapearStatusWhatsappLocal(status = '', qrCode = null) {
  const statusNormalizado = String(status || '').trim();

  if (['conectado', 'isLogged', 'qrReadSuccess'].includes(statusNormalizado)) {
    return 'conectado';
  }

  if (statusNormalizado === 'erro') {
    return 'erro';
  }

  if (statusNormalizado === 'iniciando') {
    return 'iniciando';
  }

  if (statusNormalizado === 'qr_pronto' || qrCode) {
    return 'qr_pronto';
  }

  return 'nao_configurado';
}

async function consultarStatusWhatsappLocal(assinaturaId) {
  const sessao = statusSessaoWhatsappLocal(assinaturaId);
  const statusMapeado = mapearStatusWhatsappLocal(sessao.status, sessao.qrCode);
  const conectado = statusMapeado === 'conectado';
  const qrCode = conectado ? null : sessao.qrCode || null;
  const mensagem =
    sessao.ultimoErro ||
    (conectado
      ? 'WhatsApp conectado com sucesso.'
      : qrCode
        ? 'Escaneie o QR Code com o WhatsApp para concluir a conexao.'
        : statusMapeado === 'iniciando'
          ? 'Preparando a sessao do WhatsApp.'
          : 'Clique em Gerar QR Code para iniciar a conexao do WhatsApp.');

  const dadosPersistencia = {
    whatsappStatus: statusMapeado,
    whatsappUltimoErro: sessao.ultimoErro || null,
    whatsappUltimoCheckEm: agoraIso(),
  };

  if (qrCode) {
    dadosPersistencia.whatsappUltimoQrEm = agoraIso();
  }

  await persistirSessaoWhatsapp(assinaturaId, dadosPersistencia);

  return respostaStatusWhatsapp({
    status: statusMapeado,
    qrCode,
    qr: qrCode,
    ultimoErro: sessao.ultimoErro || null,
    instancia: `assinatura-${assinaturaId}`,
    conectado,
    precisaQr: !conectado,
    mensagem,
    iniciadoEm: sessao.iniciadoEm || null,
    atualizadoEm: sessao.atualizadoEm || null,
  });
}

function normalizarNumeroWhatsappBrasil(numero = '') {
  let digitos = String(numero || '').replace(/\D/g, '');
  if (digitos.startsWith('00')) digitos = digitos.slice(2);
  // DDD 55 tambem e nacional: o comprimento distingue DDD de codigo do pais.
  if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
  return /^55[1-9]{2}(?:[2-5]\d{7}|9\d{8})$/.test(digitos) ? digitos : null;
}

function iniciarSessaoWhatsappLocalSemBloquear(assinaturaId) {
  iniciarSessaoWhatsappLocal(assinaturaId).catch((error) => {
    console.error(`Erro ao iniciar sessao local do WhatsApp da assinatura ${assinaturaId}:`, error.message);
  });
}

async function aguardarQrWhatsappLocal(assinaturaId, { timeoutMs = 12000, intervalMs = 400 } = {}) {
  const startedAt = Date.now();
  let statusAtual = await consultarStatusWhatsappLocal(assinaturaId);

  while (Date.now() - startedAt < timeoutMs) {
    if (statusAtual.conectado || statusAtual.qrCode || statusAtual.ultimoErro) {
      return statusAtual;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    statusAtual = await consultarStatusWhatsappLocal(assinaturaId);
  }

  return statusAtual;
}

function statusLocalPareceTravado(status = {}) {
  if (status.conectado || status.qrCode || status.ultimoErro || status.status !== 'iniciando' || !status.iniciadoEm) {
    return false;
  }

  return Date.now() - Number(status.iniciadoEm) > 45000;
}

function agoraIso() {
  return new Date().toISOString();
}

function precisaGerarQrPorStatus(status = '') {
  return ['nao_configurado', 'close', 'closed', 'disconnected', 'logout'].includes(String(status || '').trim().toLowerCase());
}

function compartilharGeracaoQr(instanceName, executor, modo = 'qr') {
  const chave = String(instanceName);
  const atual = whatsappQrJobs.get(chave);
  if (atual) {
    if (atual.modo !== modo) {
      throw createEvolutionError('Ja existe uma solicitacao de conexao em andamento. Aguarde sua conclusao.', 409, 'WHATSAPP_BUSY');
    }
    return atual.promise;
  }
  const promise = Promise.resolve().then(executor).finally(() => whatsappQrJobs.delete(chave));
  whatsappQrJobs.set(chave, { modo, promise });
  return promise;
}

async function validarEvolutionApiDisponivel() {
  await validarConexaoApi();
}

async function persistirSessaoWhatsapp(assinaturaId, valores = {}) {
  const campos = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappSession')) {
    campos.push(`whatsapp_session = $${params.length + 1}`);
    params.push(valores.whatsappSession || null);
  }

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappStatus')) {
    campos.push(`whatsapp_status = $${params.length + 1}`);
    params.push(valores.whatsappStatus || 'nao_configurado');
  }

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappUltimoErro')) {
    campos.push(`whatsapp_ultimo_erro = $${params.length + 1}`);
    params.push(valores.whatsappUltimoErro || null);
  }

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappUltimoCheckEm')) {
    campos.push(`whatsapp_ultimo_check_em = $${params.length + 1}`);
    params.push(valores.whatsappUltimoCheckEm || null);
  }

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappUltimoQrEm')) {
    campos.push(`whatsapp_ultimo_qr_em = $${params.length + 1}`);
    params.push(valores.whatsappUltimoQrEm || null);
  }

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappNumero')) {
    campos.push(`whatsapp_numero = $${params.length + 1}`);
    params.push(valores.whatsappNumero || null);
  }

  if (!campos.length) {
    return;
  }

  params.push(assinaturaId);

  await runAsync(
    `UPDATE assinaturas
     SET ${campos.join(', ')},
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $${params.length}`,
    params
  );
}

async function resetarSessaoWhatsapp(assinaturaId) {
  await persistirSessaoWhatsapp(assinaturaId, {
    whatsappSession: null,
    whatsappStatus: 'nao_configurado',
    whatsappUltimoErro: null,
    whatsappUltimoCheckEm: agoraIso(),
    whatsappUltimoQrEm: null,
  });
}

async function configurarWebhookEvolutionSePossivel(instanceName) {
  const appUrl = String(process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');

  if (!appUrl) {
    return;
  }

  try {
    await configurarWebhookInstancia(instanceName, `${appUrl}/api/webhook/evolution`);
  } catch (error) {
    logEvolutionError(`configuracao de webhook da instancia ${instanceName}`, error);
  }
}

async function garantirInstanciaWhatsapp(assinatura, phoneNumber = '', options = {}) {
  const instanceName = String(assinatura?.whatsapp_session || '').trim() || gerarNomeInstancia(assinatura.id);
  let estado;
  let ausente = false;
  let incerto = null;
  try {
    estado = await obterEstadoConexao(instanceName, options);
    if (!extrairEstadoInstancia(estado)) {
      incerto = createEvolutionError('Nao foi possivel confirmar o estado da instancia do WhatsApp.', 502, 'EVOLUTION_STATE_UNKNOWN');
    }
  } catch (error) {
    if (error.code === 'EVOLUTION_INSTANCE_NOT_FOUND' && error.upstreamStatus === 404) ausente = true;
    else if (error.code === 'EVOLUTION_ENDPOINT_NOT_FOUND' && error.upstreamStatus === 404) incerto = error;
    else throw error; // 429, autenticacao, rede, timeout e 5xx nunca autorizam criar.
  }
  if (incerto) {
    const existe = await confirmarExistenciaInstancia(instanceName, options);
    if (existe) throw incerto; // Existencia confirmada nao substitui estado atual desconhecido.
    ausente = true;
  }
  if (ausente) {
    try {
      await criarInstancia(instanceName, phoneNumber, options);
    } catch (error) {
      if (error.code !== 'EVOLUTION_INSTANCE_EXISTS') throw error;
      if (!(await confirmarExistenciaInstancia(instanceName, { ...options, force: true }))) throw error;
    }
    estado = await obterEstadoConexao(instanceName, options);
    if (!extrairEstadoInstancia(estado)) throw createEvolutionError('Nao foi possivel confirmar o estado da instancia do WhatsApp.', 502, 'EVOLUTION_STATE_UNKNOWN');
  }
  if (instanceName !== assinatura?.whatsapp_session) {
    await persistirSessaoWhatsapp(assinatura.id, { whatsappSession: instanceName });
  }
  return { instanceName, estado };
}

async function consultarStatusWhatsappEvolution(assinatura, options = {}, estadoConfirmado = null) {
  const instanceName = String(assinatura?.whatsapp_session || '').trim();

  if (!instanceName) {
    await persistirSessaoWhatsapp(assinatura.id, {
      whatsappStatus: 'nao_configurado',
      whatsappUltimoErro: null,
      whatsappUltimoCheckEm: agoraIso(),
    });

    return respostaStatusWhatsapp({
      status: 'nao_configurado',
      instancia: null,
      conectado: false,
      precisaQr: true,
      mensagem: 'Nenhuma sessao do WhatsApp foi iniciada ainda.',
    });
  }

  try {
    const estado = estadoConfirmado || await obterEstadoConexao(instanceName, { timeoutMs: 12000, ...options });
    const statusMapeado = mapearStatusWhatsappEvolution(estado?.instance?.state || estado?.state || estado?.instance?.status);

    await persistirSessaoWhatsapp(assinatura.id, {
      whatsappStatus: statusMapeado,
      whatsappUltimoErro: null,
      whatsappUltimoCheckEm: agoraIso(),
    });

    if (statusMapeado === 'conectado') {
      return respostaStatusWhatsapp({
        status: statusMapeado,
        instancia: instanceName,
        conectado: true,
        precisaQr: false,
        mensagem: 'WhatsApp conectado com sucesso.',
      });
    }

    if (statusMapeado === 'iniciando') {
      return { connectionAttemptActive: true, ...respostaStatusWhatsapp({
        status: statusMapeado,
        instancia: instanceName,
        conectado: false,
        precisaQr: false,
        mensagem: 'Conexao em andamento. Aguarde a confirmacao do WhatsApp.',
      }) };
    }

    if (tentativaConexaoAtiva(instanceName)) return respostaTentativaWhatsapp(instanceName);
    return { connectionAttemptActive: false, ...respostaStatusWhatsapp({
      status: statusMapeado,
      instancia: instanceName,
      conectado: false,
      precisaQr: precisaGerarQrPorStatus(statusMapeado),
      mensagem: 'A instancia existe, mas ainda precisa conectar o WhatsApp.',
    }) };
  } catch (error) {
    logEvolutionError(`status da assinatura ${assinatura.id}`, error);

    if (error?.code === 'EVOLUTION_INSTANCE_NOT_FOUND') {
      await resetarSessaoWhatsapp(assinatura.id);

      return respostaStatusWhatsapp({
        status: 'nao_configurado',
        ultimoErro: error.message,
        instancia: null,
        conectado: false,
        precisaQr: true,
        mensagem: 'Nenhuma sessao ativa. Informe seu numero para gerar um codigo de conexao.',
      });
    }

    await persistirSessaoWhatsapp(assinatura.id, {
      whatsappStatus: 'erro',
      whatsappUltimoErro: error.message || 'Falha ao consultar a Evolution API.',
      whatsappUltimoCheckEm: agoraIso(),
    });

    return { rateLimitSource: error.rateLimitSource, upstreamStatus: error.upstreamStatus, retryAfterSeconds: error.retryAfterSeconds, retryAt: error.retryAt, httpStatus: [401, 403].includes(error.statusCode) ? 502 : (error.statusCode || 500), errorCode: error.code, ...respostaStatusWhatsapp({
      status: 'erro',
      ultimoErro: error.message,
      instancia: instanceName,
      conectado: false,
      precisaQr: false,
      mensagem: error.message,
    }) };
  }
}

function respostaTentativaWhatsapp(instanceName) {
  return { ...respostaStatusWhatsapp({ status: 'pairing', instancia: instanceName,
    conectado: false, precisaQr: false,
    mensagem: 'Tentativa em andamento. Acompanhando somente o estado da conexao. Se nenhum codigo foi exibido, encerre a tentativa em Desconectar WhatsApp antes de tentar novamente.',
  }), connectionAttemptActive: true, pending: true };
}

async function gerarQrWhatsappEvolution(assinatura) {
  return compartilharGeracaoQr(assinatura.whatsapp_session || gerarNomeInstancia(assinatura.id), async () => {
    const options = { deadline: Date.now() + 60000, retryAttempts: 1, requestId: crypto.randomUUID() };
    logEvolution('connection_start', { requestId: options.requestId, mode: 'qr', instance: assinatura.whatsapp_session || gerarNomeInstancia(assinatura.id) });
    try {
      const { instanceName, estado: estadoConfirmado } = await garantirInstanciaWhatsapp(assinatura, '', options);
      const estado = await consultarStatusWhatsappEvolution({ ...assinatura, whatsapp_session: instanceName }, options, estadoConfirmado);
      if (!estado.success) throw Object.assign(createEvolutionError(estado.message, estado.httpStatus, estado.errorCode), { rateLimitSource: estado.rateLimitSource, upstreamStatus: estado.upstreamStatus, retryAfterSeconds: estado.retryAfterSeconds, retryAt: estado.retryAt });
      if (estado.conectado) return { ...estado, qrCode: null, qr: null };
      if (estado.connectionAttemptActive) return respostaTentativaWhatsapp(instanceName);
      const conexao = await conectarInstancia(instanceName, '', options);
      if (['open', 'connected'].includes(conexao?.instance?.state || conexao?.state)) {
        return respostaStatusWhatsapp({ status: 'connected', conectado: true, instancia: instanceName, mensagem: 'WhatsApp conectado.' });
      }
      const qrCode = construirQrCodeUrl(extrairConteudoQr(conexao));
      if (qrCode) {
        await persistirSessaoWhatsapp(assinatura.id, { whatsappSession: instanceName, whatsappStatus: 'qr_pronto',
          whatsappUltimoErro: null, whatsappUltimoCheckEm: agoraIso(), whatsappUltimoQrEm: agoraIso() });
        void configurarWebhookEvolutionSePossivel(instanceName);
        return { ...respostaStatusWhatsapp({ status: 'success', qrCode, qr: qrCode, instancia: instanceName,
          conectado: false, precisaQr: true, mensagem: 'Escaneie o QR Code com o WhatsApp para concluir a conexao.' }), connectionAttemptActive: true };
      }
      return respostaTentativaWhatsapp(instanceName);
    } catch (error) {
      await persistirSessaoWhatsapp(assinatura.id, { whatsappStatus: 'erro', whatsappUltimoErro: error.message, whatsappUltimoCheckEm: agoraIso() });
      throw error;
    }
  });
}

router.get('/agendamentos', requirePainelOuBridge, (req, res) => {
  const query = `
    SELECT
      a.id,
      COALESCE(a.nome_cliente, c.nome) AS cliente,
      COALESCE(a.telefone, c.telefone) AS telefone,
      COALESCE(a.servico_nome, s.nome) AS servico,
      COALESCE(a.preco, s.preco, 0) AS preco,
      a.data,
      a.hora,
      a.status,
      a.lembrete_15_enviado_em,
      a.lembrete_7_enviado_em
    FROM agendamentos a
    LEFT JOIN clientes c ON c.id = a.cliente_id
    LEFT JOIN servicos s ON s.id = a.servico_id
    WHERE a.assinatura_id = $1
    ORDER BY a.data ASC, a.hora ASC
  `;

  db.all(query, [req.assinatura.id], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.json(rows);
  });
});

router.get('/disponibilidade', requirePainelOuBridge, async (req, res) => {
  try {
    const { createScheduling } = require('./services/whatsapp/scheduling');
    await db.ready;
    res.json({ data: req.query.data, horarios: await createScheduling(db).times(req.assinatura.id, req.query.data) });
  } catch { res.status(500).json({ error: 'Falha ao consultar disponibilidade.' }); }
});

router.post('/agendamentos', requirePainelOuBridge, async (req, res) => {
  const { cliente, telefone, servicoId, servicoNome, data, hora } = req.body;
  const phoneDigits = String(telefone || '').replace(/\D/g, '');
  const phone = phoneDigits.length === 10 || phoneDigits.length === 11 ? `55${phoneDigits}` : phoneDigits;
  if (!/^\d{10,15}$/.test(phone) || typeof cliente !== 'string' || cliente.trim().length < 2 || cliente.length > 100) {
    return res.status(400).json({ error: 'Informe nome e telefone válidos.' });
  }
  try {
    const { transaction } = require('./services/whatsapp/sessionRepository');
    const { createScheduling } = require('./services/whatsapp/scheduling');
    const result = await transaction(async connection => {
      const scheduling = createScheduling(connection);
      const services = await scheduling.services(req.assinatura.id);
      const service = services.find(s => servicoId ? String(s.id) === String(servicoId) : s.name === servicoNome);
      if (!service) return null;
      const booking = await scheduling.book(req.assinatura.id, phone, { name: cliente.trim(), service, date: data, time: hora });
      return booking ? { id: booking.lastID, cliente: cliente.trim(), telefone: phone, servico: service.name, preco: service.price, data, hora, status: 'confirmado' } : null;
    });
    if (!result) return res.status(409).json({ error: 'Serviço ou horário indisponível. Consulte a disponibilidade novamente.' });
    res.status(201).json(result);
  } catch {
    res.status(500).json({ error: 'Não foi possível salvar o agendamento.' });
  }
});

router.delete('/agendamentos/:id', requirePainelOuBridge, (req, res) => {
  const { id } = req.params;

  db.run("DELETE FROM agendamentos WHERE id = $1 AND assinatura_id = $2", [id, req.assinatura.id], function onDelete(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    if (this.changes === 0) {
      res.status(404).json({ error: 'Agendamento nao encontrado.' });
      return;
    }

    res.json({ success: true });
  });
});

router.post('/agendamentos/:id/lembrete-15', requirePainelOuBridge, async (req, res) => {
  const { id } = req.params;
  const enviadoEm = String(req.body?.enviadoEm || new Date().toISOString());

  try {
    const resultado = await runAsync(
      `UPDATE agendamentos
       SET lembrete_15_enviado_em = $1
       WHERE id = $2
         AND assinatura_id = $3
         AND lembrete_15_enviado_em IS NULL`,
      [enviadoEm, id, req.assinatura.id]
    );

    if (!resultado.changes) {
      res.json({ ok: true, atualizado: false });
      return;
    }

    res.json({ ok: true, atualizado: true, enviadoEm });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/agendamentos/:id/lembrete-7', requirePainelOuBridge, async (req, res) => {
  const { id } = req.params;
  const enviadoEm = String(req.body?.enviadoEm || new Date().toISOString());

  try {
    const resultado = await runAsync(
      `UPDATE agendamentos
       SET lembrete_7_enviado_em = $1
       WHERE id = $2
         AND assinatura_id = $3
         AND lembrete_7_enviado_em IS NULL`,
      [enviadoEm, id, req.assinatura.id]
    );

    if (!resultado.changes) {
      res.json({ ok: true, atualizado: false });
      return;
    }

    res.json({ ok: true, atualizado: true, enviadoEm });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/faturamento', requireBarbeiro, (req, res) => {
  const { periodo } = req.query;
  let query = `
    SELECT SUM(COALESCE(a.preco, s.preco, 0)) AS total
    FROM agendamentos a
    LEFT JOIN servicos s ON a.servico_id = s.id
    WHERE a.status = 'confirmado'
      AND a.assinatura_id = $1
  `;
  const params = [req.assinatura.id];

  if (periodo === 'dia') {
    query += " AND a.data = to_char(CURRENT_DATE, 'YYYY-MM-DD')";
  }

  if (periodo === 'mes') {
    query += " AND substring(a.data, 1, 7) = to_char(CURRENT_DATE, 'YYYY-MM')";
  }

  if (periodo === 'ano') {
    query += " AND substring(a.data, 1, 4) = to_char(CURRENT_DATE, 'YYYY')";
  }

  db.get(query, params, (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.json({ total: row?.total || 0 });
  });
});

router.get('/bloqueios', requirePainelOuBridge, (req, res) => {
  db.all(
    "SELECT * FROM bloqueios WHERE assinatura_id = $1 ORDER BY data ASC, hora ASC",
    [req.assinatura.id],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }

      res.json(rows);
    }
  );
});

router.post('/webhook', requirePainelOuBridge, async (req, res) => {
  try {
    const resultado = await handleWhatsappWebhook({
      body: req.body,
      headers: req.headers,
      assinatura: req.assinatura,
    });

    res.json(resultado);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/webhook/evolution', async (req, res) => {
  try {
    const resultado = await processarWebhookEvolution(req.body || {}, req.headers);
    res.json(resultado);
  } catch (error) {
    console.error('[WhatsApp] erro ao processar webhook', { status: error.statusCode || 503 });
    res.status(error.statusCode || 503).json({ error: error.statusCode === 401 ? 'Webhook não autorizado.' : 'Falha temporária no processamento.' });
  }
});

router.post('/bloqueios', requirePainelOuBridge, (req, res) => {
  const { data, hora } = req.body;

  if (!data || !hora) {
    res.status(400).json({ error: 'Data e hora sao obrigatorias.' });
    return;
  }

  db.run(
    "INSERT INTO bloqueios (assinatura_id, data, hora) VALUES ($1, $2, $3)",
    [req.assinatura.id, data, hora],
    function onInsert(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }

      res.status(201).json({ id: this.lastID, data, hora });
    }
  );
});

router.delete('/bloqueios/:id', requirePainelOuBridge, (req, res) => {
  const { id } = req.params;

  db.run("DELETE FROM bloqueios WHERE id = $1 AND assinatura_id = $2", [id, req.assinatura.id], function onDelete(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    if (this.changes === 0) {
      res.status(404).json({ error: 'Bloqueio nao encontrado.' });
      return;
    }

    res.json({ success: true });
  });
});

router.get('/servicos', (req, res) => {
  db.all('SELECT * FROM servicos ORDER BY id ASC', [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.json(rows);
  });
});

router.get('/publico/assinatura-config', async (req, res) => {
  try {
    const suporteNumero = await getConfiguracao('suporte_numero');
    const evolution = getEvolutionConfig();
    const pix = null;
    const provider = usarEvolutionWhatsapp() ? 'evolution_api' : 'wppconnect_local';

    res.json({
      suporteNumero,
      valorMensal: VALOR_MENSAL_PADRAO,
      whatsappBridgeUrl: null,
      plan: PROFESSIONAL_PLAN,
      whatsappLocalOnly: provider === 'wppconnect_local',
      whatsappProvider: provider,
      whatsappEnabled: true,
      whatsappSetupMessage:
        provider === 'evolution_api'
          ? 'Informe seu numero para gerar o codigo de conexao do WhatsApp.'
          : '',
      whatsappRetry: {
        attempts: evolution.retryAttempts,
        delayMs: evolution.retryDelayMs,
        timeoutMs: evolution.timeoutMs,
      },
      gateway: { provider: 'mercado_pago', label: 'Mercado Pago', enabled: payments.configured() },
      pix,
      cobrancaMensagem: MENSAGEM_COBRANCA_PADRAO,
      diasVencimento: DIAS_VENCIMENTO,
      metodosPagamento: METODOS_PAGAMENTO,
      diasSemana: DIAS_SEMANA,
      funcionamentoPadrao: {
        diasFuncionamento: diasFuncionamentoPadrao(),
        horarioAbertura: '08:00',
        horarioAlmocoInicio: '12:00',
        horarioAlmocoFim: '13:00',
        horarioFechamento: '18:00',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/mercadopago/webhook', async (req, res) => {
  try {
    const result = await payments.webhook(req);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Mercado Pago] Webhook nao processado', { status: error.statusCode || 503 });
    res.status(error.statusCode || 503).json({ error: error.publicMessage || 'Nao foi possivel processar a confirmacao. Tente novamente.' });
  }
});

router.get('/publico/assinaturas/:id/status', async (req, res) => {
  const { id } = req.params;

  try {
    const assinatura = await carregarAssinaturaAtualizada(id);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const acesso = avaliarAcessoAssinatura(assinatura);

    res.json({
      id: assinatura.id,
      ...montarEstadoPagamento(assinatura),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/publico/assinaturas/:id/checkout', async (req, res) => {
  const { id } = req.params;

  try {
    const assinatura = await getAsync("SELECT * FROM assinaturas WHERE id = $1", [id]);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    limparSessoesBarbeiroExpiradas();
    const session = barberSessions.get(String(req.headers['x-barbeiro-token'] || ''));
    if (Number(session?.assinaturaId) !== Number(id) && !verificarSenha(req.body?.senha || '', assinatura)) {
      return res.status(401).json({ error: 'Informe a senha da conta para gerar o pagamento.' });
    }
    const checkout = await payments.checkout(assinatura);

    res.json({
      checkoutUrl: checkout.init_point || checkout.sandbox_init_point || null,
      plan: checkout.plan,
      gatewayStatus: checkout.status || 'pending',
      provider: 'mercado_pago',
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.publicMessage || 'Nao foi possivel gerar o pagamento. Tente novamente.' });
  }
});

router.post('/barbeiro/login', async (req, res) => {
  const { identificador, senha } = req.body;

  if (!identificador || !senha) {
    res.status(400).json({ error: 'Informe seu Gmail e a senha.' });
    return;
  }

  try {
    const assinaturaEncontrada = await getAsync(
      `SELECT *
       FROM assinaturas
       WHERE telefone = $1
          OR whatsapp_numero = $2
          OR email = $3
       ORDER BY id DESC
       LIMIT 1`,
      [identificador, identificador, identificador]
    );
    const assinatura = await sincronizarStatusPorVencimento(assinaturaEncontrada);

    if (!assinatura || !verificarSenha(senha, assinatura)) {
      res.status(401).json({ error: 'Login invalido.' });
      return;
    }

    const acesso = avaliarAcessoAssinatura(assinatura);

    if (!acesso.liberado) {
      res.status(403).json({
        error: acesso.mensagem,
        ...montarEstadoPagamento(assinatura),
      });
      return;
    }

    const token = criarSessaoBarbeiro(assinatura.id);

    res.json({
      token,
      expiresInDays: 7,
      assinatura: await montarRespostaAssinatura(assinatura.id),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/barbeiro/recuperar-senha/solicitar', async (req, res) => {
  const email = normalizarEmail(req.body.email || req.body.identificador);

  if (!email) {
    res.status(400).json({ error: 'Informe seu Gmail cadastrado para recuperar a senha.' });
    return;
  }

  try {
    const assinatura = await buscarAssinaturaPorEmailRecuperacao(email);

    if (!assinatura) {
      res.status(404).json({ error: 'Nao encontrei uma conta com esse Gmail.' });
      return;
    }

    if (!assinatura.email) {
      res.status(400).json({ error: 'Essa conta nao possui Gmail cadastrado para recuperar a senha.' });
      return;
    }

    if (!emailRecuperacaoConfigurado()) {
      const error = new Error(
        'Recuperacao por e-mail ainda nao esta configurada neste servidor. Adicione RESEND_API_KEY, BREVO_API_KEY ou credenciais SMTP.'
      );
      error.statusCode = 501;
      throw error;
    }

    if (smtpProvavelmenteBloqueadoNaHospedagem()) {
      throw criarErroConfiguracaoEmailHospedado();
    }

    const token = criarTokenRecuperacaoSeguro();
    const tokenHash = gerarHashTokenRecuperacaoSeguro(token);
    const expiresAt = calcularExpiracaoRecuperacaoSenha(60);
    const linkRecuperacao = `${getPublicAppUrl(req)}/redefinir-senha.html?token=${encodeURIComponent(token)}`;

    await salvarTokenRecuperacaoSenha(assinatura.id, tokenHash, expiresAt);
    await enviarLinkRecuperacaoPorEmailSeguro(assinatura.email, linkRecuperacao);

    res.json({
      ok: true,
      mensagem: 'Enviamos um link de recuperacao para o seu Gmail.',
    });
  } catch (error) {
    console.error('[recuperacao-email] falha ao solicitar link', {
      email,
      statusCode: error.statusCode || 500,
      message: error.message,
      stack: error.stack,
    });
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.get('/barbeiro/recuperar-senha/token-status', async (req, res) => {
  const token = String(req.query.token || '').trim();

  if (!token) {
    res.status(400).json({ error: 'Token obrigatorio.' });
    return;
  }

  try {
    const recovery = await carregarTokenRecuperacaoSenha(token);

    if (!recovery) {
      res.status(404).json({ error: 'Link invalido ou expirado.' });
      return;
    }

    if (new Date(recovery.expires_at).getTime() <= Date.now()) {
      await runAsync("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1", [recovery.id]);
      res.status(410).json({ error: 'Esse link de recuperacao expirou.' });
      return;
    }

    res.json({
      ok: true,
      email: recovery.email,
      expiresAt: recovery.expires_at,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/barbeiro/recuperar-senha/redefinir', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const novaSenha = String(req.body.novaSenha || '');
  const confirmarSenha = String(req.body.confirmarSenha || '');

  if (!token || !novaSenha || !confirmarSenha) {
    res.status(400).json({ error: 'Informe o token e preencha a nova senha duas vezes.' });
    return;
  }

  if (novaSenha.length < 4) {
    res.status(400).json({ error: 'A nova senha precisa ter pelo menos 4 caracteres.' });
    return;
  }

  if (novaSenha !== confirmarSenha) {
    res.status(400).json({ error: 'A confirmacao da senha nao confere.' });
    return;
  }

  try {
    const recovery = await carregarTokenRecuperacaoSenha(token);

    if (!recovery) {
      res.status(404).json({ error: 'Link invalido ou expirado.' });
      return;
    }

    if (new Date(recovery.expires_at).getTime() <= Date.now()) {
      await runAsync("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1", [recovery.id]);
      res.status(410).json({ error: 'Esse link de recuperacao expirou.' });
      return;
    }

    const credenciais = criarCredenciaisSenha(novaSenha);

    await runAsync(
      `UPDATE assinaturas
       SET senha_hash = $1,
           senha_salt = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [credenciais.hash, credenciais.salt, recovery.assinatura_id]
    );

    await runAsync("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1", [recovery.id]);

    res.json({ ok: true, mensagem: 'Senha atualizada com sucesso. Agora voce ja pode entrar no painel.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/barbeiro/me', requireBarbeiro, async (req, res) => {
  try {
    res.json(await montarRespostaAssinatura(req.assinatura.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/barbeiro/logout', requireBarbeiro, (req, res) => {
  barberSessions.delete(req.barbeiroToken);
  res.json({ ok: true });
});

router.post('/publico/assinaturas', async (req, res) => {
  const {
    barbeariaNome,
    responsavelNome,
    telefone,
    email,
    senha,
    metodoPagamento,
    diaVencimento,
    whatsappNumero,
    diasFuncionamento,
    horarioAbertura,
    horarioAlmocoInicio,
    horarioAlmocoFim,
    horarioFechamento,
    servicos,
  } = req.body;

  if (!barbeariaNome || !responsavelNome || !telefone || !senha || !metodoPagamento || !diaVencimento) {
    res.status(400).json({ error: 'Preencha todos os campos obrigatorios.' });
    return;
  }

  if (!email) {
    res.status(400).json({ error: 'Informe um email valido para o cadastro.' });
    return;
  }

  if (String(senha).length < 4) {
    res.status(400).json({ error: 'A senha precisa ter pelo menos 4 caracteres.' });
    return;
  }

  if (!Array.isArray(servicos) || servicos.length === 0) {
    res.status(400).json({ error: 'Cadastre pelo menos um servico com preco.' });
    return;
  }

  const servicosValidos = servicos
    .map((item) => ({
      nome: String(item.nome || '').trim(),
      preco: Number(item.preco),
    }))
    .filter((item) => item.nome && Number.isFinite(item.preco) && item.preco > 0);

  if (!servicosValidos.length) {
    res.status(400).json({ error: 'Os servicos informados nao sao validos.' });
    return;
  }

  const dia = Number.parseInt(diaVencimento, 10);

  if (!DIAS_VENCIMENTO.includes(dia)) {
    res.status(400).json({ error: 'Dia de vencimento invalido.' });
    return;
  }

  if (!METODOS_PAGAMENTO.includes(metodoPagamento)) {
    res.status(400).json({ error: 'Metodo de pagamento invalido.' });
    return;
  }

  try {
    const assinaturaExistente = await getAsync(
      `SELECT *
       FROM assinaturas
       WHERE telefone = $1
          OR whatsapp_numero = $2
          OR (email <> '' AND email = $3)
          OR barbearia_nome = $4
       LIMIT 1`,
      [telefone, whatsappNumero || telefone, email || '', barbeariaNome]
    );

    if (assinaturaExistente) {
      return res.status(409).json({
        code: 'ASSINATURA_EXISTENTE',
        error: 'Os dados informados pertencem a uma assinatura existente. Entre pela pagina inicial para consultar seu contrato e continuar o pagamento. Nenhum novo cadastro foi criado.',
      });
    }

    const suporteNumero = await getConfiguracao('suporte_numero');
    const proximoVencimento = calcularProximoVencimento(dia);
    const diasSerializados = serializarDiasFuncionamento(diasFuncionamento);
    const credenciais = criarCredenciaisSenha(senha);

    const result = await runAsync(
      `INSERT INTO assinaturas (
        barbearia_nome,
        responsavel_nome,
        telefone,
        email,
        metodo_pagamento,
        dia_vencimento,
        valor_mensal,
        status,
        suporte_numero,
        proximo_vencimento,
        whatsapp_numero,
        whatsapp_status,
        whatsapp_session,
        trial_usado,
        trial_started_at,
        trial_expires_at,
        dias_funcionamento,
        horario_abertura,
        horario_almoco_inicio,
        horario_almoco_fim,
        horario_fechamento,
        senha_hash,
        senha_salt,
        valor_plano,
        plano
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $7, $24)`,
      [
        barbeariaNome,
        responsavelNome,
        telefone,
        email || '',
        metodoPagamento,
        dia,
        VALOR_MENSAL_PADRAO,
        'pendente',
        suporteNumero,
        proximoVencimento,
        whatsappNumero || telefone,
        'nao_configurado',
        null,
        0,
        null,
        null,
        diasSerializados,
        horarioAbertura || '08:00',
        horarioAlmocoInicio || '12:00',
        horarioAlmocoFim || '13:00',
        horarioFechamento || '18:00',
        credenciais.hash,
        credenciais.salt,
        NOME_PLANO_PADRAO,
      ]
    );

    for (const servico of servicosValidos) {
      await runAsync(
        "INSERT INTO servicos_assinatura (assinatura_id, nome, preco) VALUES ($1, $2, $3)",
        [result.lastID, servico.nome, servico.preco]
      );
    }

    await persistirSessaoWhatsapp(result.lastID, {
      whatsappSession: gerarNomeInstancia(result.lastID),
      whatsappStatus: 'nao_configurado',
      whatsappUltimoErro: null,
      whatsappUltimoCheckEm: null,
      whatsappUltimoQrEm: null,
    });

    const assinaturaCriada = await montarRespostaAssinatura(result.lastID);

    res.status(201).json({
      mensagem: 'Cadastro concluido. Finalize o pagamento no Mercado Pago para liberar o acesso.',
      pix: assinaturaCriada.pix,
      assinatura: assinaturaCriada,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.publicMessage || 'Nao foi possivel salvar o cadastro. Tente novamente.' });
  }
});

async function gerarPairingCodeWhatsappEvolution(assinatura, numeroWhatsapp) {
  return compartilharGeracaoQr(assinatura.whatsapp_session || gerarNomeInstancia(assinatura.id), async () => {
    const options = { deadline: Date.now() + 60000, retryAttempts: 1, requestId: crypto.randomUUID() };
    logEvolution('connection_start', { requestId: options.requestId, mode: 'pairing', instance: assinatura.whatsapp_session || gerarNomeInstancia(assinatura.id) });
    const { instanceName, estado } = await garantirInstanciaWhatsapp(assinatura, numeroWhatsapp, options);
    const estadoAtual = await consultarStatusWhatsappEvolution({ ...assinatura, whatsapp_session: instanceName }, options, estado);
    if (!estadoAtual.success) throw Object.assign(createEvolutionError(estadoAtual.message, estadoAtual.httpStatus, estadoAtual.errorCode), { rateLimitSource: estadoAtual.rateLimitSource, upstreamStatus: estadoAtual.upstreamStatus, retryAfterSeconds: estadoAtual.retryAfterSeconds, retryAt: estadoAtual.retryAt });
    if (estadoAtual.conectado) return { ...estadoAtual, status: 'connected', code: null, pairingCode: null };
    if (estadoAtual.status === 'iniciando' && assinatura.whatsapp_numero && assinatura.whatsapp_numero !== numeroWhatsapp) {
      throw createEvolutionError('Existe uma conexao em andamento com outro numero. Desconecte antes de trocar o numero.', 409, 'WHATSAPP_BUSY');
    }
    if (estadoAtual.connectionAttemptActive) return respostaTentativaWhatsapp(instanceName);

    await persistirSessaoWhatsapp(assinatura.id, {
      whatsappSession: instanceName, whatsappNumero: numeroWhatsapp,
      whatsappStatus: 'iniciando', whatsappUltimoErro: null, whatsappUltimoCheckEm: agoraIso(),
    });
    console.info('[WHATSAPP] Solicitando pairing code', { assinaturaId: assinatura.id, numero: `***${numeroWhatsapp.slice(-4)}` });
    // /connect can restart a closed socket: issue it only once per attempt.
    const resposta = await conectarInstancia(instanceName, numeroWhatsapp, options);
    const conectado = ['open', 'connected'].includes(resposta?.instance?.state || resposta?.state);
    if (conectado) return { ...respostaStatusWhatsapp({ status: 'connected', conectado: true, instancia: instanceName, mensagem: 'WhatsApp conectado com sucesso.' }), code: null, pairingCode: null };
    const pairingCode = extrairPairingCode(resposta);
    if (pairingCode) {
      console.info('[WHATSAPP] Pairing code gerado', { assinaturaId: assinatura.id });
      void configurarWebhookEvolutionSePossivel(instanceName);
      return { ...respostaStatusWhatsapp({
        status: 'pairing_code', instancia: instanceName,
        mensagem: 'Codigo gerado. Conclua a vinculacao pelo WhatsApp.',
      }), code: pairingCode, pairingCode, numeroWhatsapp, connectionAttemptActive: true };
    }
    if (resposta?.error) throw createEvolutionError('Erro interno no servico do WhatsApp ao solicitar o codigo.', 502, 'EVOLUTION_PAIRING_FAILED', resposta);
    return respostaTentativaWhatsapp(instanceName);
  }, `pairing:${numeroWhatsapp}`);
}

function responderErroWhatsapp(res, error) {
  const statusCode = error.code?.startsWith('EVOLUTION_') && [401, 403].includes(error.statusCode)
    ? 502 : (error.statusCode || 500);
  const message = statusCode === 500 ? 'Erro interno no servico do WhatsApp. Consulte os logs do servidor.' : error.message;
  if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
  return res.status(statusCode).json({ success: false, status: 'error', connected: false, conectado: false, error: message, message, errorCode: error.code || 'WHATSAPP_INTERNAL_ERROR', rateLimitSource: error.rateLimitSource, upstreamStatus: error.upstreamStatus, retryAfterSeconds: error.retryAfterSeconds, retryAt: error.retryAt });
}

router.post('/publico/assinaturas/:id/whatsapp/pairing-code', requireBarbeiro, async (req, res) => {
  const { id } = req.params;
  try {
    if (!assinaturaPertenceAoBarbeiro(req, res)) return;
    const numeroWhatsapp = normalizarNumeroWhatsappBrasil(req.body?.phone ?? req.body?.numero);
    if (!numeroWhatsapp) throw createEvolutionError('Numero de WhatsApp invalido. Informe DDD e numero.', 400, 'INVALID_PHONE');
    const assinatura = await carregarAssinaturaAtualizada(id);
    if (!assinatura) throw createEvolutionError('Nao foi possivel localizar a assinatura.', 404, 'SUBSCRIPTION_NOT_FOUND');
    const acesso = avaliarAcessoAssinatura(assinatura);
    if (!acesso.liberado) throw createEvolutionError(acesso.mensagem, 403, 'SUBSCRIPTION_BLOCKED');
    res.json({ ok: true, ...(await gerarPairingCodeWhatsappEvolution(assinatura, numeroWhatsapp)) });
  } catch (error) {
    logEvolutionError(`pairing code da assinatura ${id}`, error);
    responderErroWhatsapp(res, error);
  }
});

router.post('/publico/assinaturas/:id/whatsapp/iniciar', requireBarbeiro, async (req, res) => {
  const { id } = req.params;

  try {
    if (!assinaturaPertenceAoBarbeiro(req, res)) {
      return;
    }

    const assinatura = await carregarAssinaturaAtualizada(id);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const acesso = avaliarAcessoAssinatura(assinatura);

    if (!acesso.liberado) {
      res.status(403).json({ error: acesso.mensagem });
      return;
    }

    const resultado = await gerarQrWhatsappEvolution(assinatura);
    res.json({ ok: resultado.status !== 'error', ...resultado });
  } catch (error) {
    logEvolutionError(`inicio do whatsapp da assinatura ${id}`, error);
    responderErroWhatsapp(res, error);
  }
});

router.get('/publico/assinaturas/:id/whatsapp/qr', requireBarbeiro, async (req, res) => {
  const { id } = req.params;
  res.set('Cache-Control', 'no-store');

  try {
    if (!assinaturaPertenceAoBarbeiro(req, res)) {
      return;
    }

    const assinatura = await carregarAssinaturaAtualizada(id);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const resultado = await consultarStatusWhatsappEvolution(assinatura);
    if (!resultado.success) throw Object.assign(createEvolutionError(resultado.message, resultado.httpStatus, resultado.errorCode), {
      rateLimitSource: resultado.rateLimitSource, upstreamStatus: resultado.upstreamStatus,
      retryAfterSeconds: resultado.retryAfterSeconds, retryAt: resultado.retryAt,
    });
    res.json(resultado);
  } catch (error) {
    logEvolutionError(`endpoint qr da assinatura ${id}`, error);
    responderErroWhatsapp(res, error);
  }
});

router.get('/whatsapp/qr', requireBarbeiro, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const assinatura = await carregarAssinaturaAtualizada(req.assinatura.id);

    if (!assinatura) {
      res.status(404).json({
        status: 'error',
        qr: null,
        message: 'Assinatura nao encontrada.',
      });
      return;
    }

    if (usarEvolutionWhatsapp()) {
      const resultado = await consultarStatusWhatsappEvolution(assinatura);
      if (!resultado.success) throw Object.assign(createEvolutionError(resultado.message, resultado.httpStatus, resultado.errorCode), {
        rateLimitSource: resultado.rateLimitSource, upstreamStatus: resultado.upstreamStatus,
        retryAfterSeconds: resultado.retryAfterSeconds, retryAt: resultado.retryAt,
      });
      res.json({
        status: resultado.status === 'error' ? 'error' : 'success',
        qr: resultado.qr || resultado.qrCode || null,
        message: resultado.mensagem || '',
        conectado: Boolean(resultado.conectado),
        whatsappStatus: resultado.status || 'nao_configurado',
        connectionAttemptActive: Boolean(resultado.connectionAttemptActive),
        retryable: false,
      });
      return;
    }

    let statusInicial = await consultarStatusWhatsappLocal(assinatura.id);

    if (statusLocalPareceTravado(statusInicial)) {
      reiniciarSessaoWhatsappLocal(assinatura.id).catch((error) => {
        console.error(`Erro ao reiniciar sessao local do WhatsApp da assinatura ${assinatura.id}:`, error.message);
      });
      statusInicial = await consultarStatusWhatsappLocal(assinatura.id);
    }

    if (!statusInicial.conectado && !statusInicial.qrCode && statusInicial.status !== 'iniciando') {
      iniciarSessaoWhatsappLocalSemBloquear(assinatura.id);
    }

    const resultado = statusInicial.qrCode || statusInicial.conectado
      ? statusInicial
      : await aguardarQrWhatsappLocal(assinatura.id);

    res.json({
      status: resultado.status === 'erro' ? 'error' : 'success',
      qr: resultado.qr || resultado.qrCode || null,
      message: resultado.mensagem || '',
      conectado: Boolean(resultado.conectado),
      whatsappStatus: resultado.status || 'nao_configurado',
      retryable: !resultado.conectado && !resultado.qr,
    });
  } catch (error) {
    if (usarEvolutionWhatsapp()) return responderErroWhatsapp(res, error);
    res.status(500).json({
      status: 'error',
      qr: null,
      message: error.message || 'Falha ao gerar QR Code.',
    });
  }
});

router.post('/publico/assinaturas/:id/whatsapp/bridge-token', requireBarbeiro, async (req, res) => {
  const { id } = req.params;

  try {
    if (!assinaturaPertenceAoBarbeiro(req, res)) {
      return;
    }

    const assinatura = await getAsync("SELECT * FROM assinaturas WHERE id = $1", [id]);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const bridgeToken = assinatura.whatsapp_bridge_token || crypto.randomBytes(24).toString('hex');

    if (bridgeToken !== assinatura.whatsapp_bridge_token) {
      await runAsync(
        `UPDATE assinaturas
         SET whatsapp_bridge_token = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [bridgeToken, id]
      );
    }

    res.json({ token: bridgeToken });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/publico/assinaturas/:id/acesso', requirePainelOuBridge, async (req, res) => {
  const { id } = req.params;

  try {
    if (!assinaturaPertenceAoBarbeiro(req, res)) {
      return;
    }

    const assinatura = await carregarAssinaturaAtualizada(id);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const acesso = avaliarAcessoAssinatura(assinatura);

    res.json({
      liberado: acesso.liberado,
      motivo: acesso.motivo,
      mensagem: acesso.mensagem,
      assinatura: mapearAssinatura(assinatura),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/publico/assinaturas/:id', requirePainelOuBridge, async (req, res) => {
  const { id } = req.params;

  try {
    if (!assinaturaPertenceAoBarbeiro(req, res)) {
      return;
    }

    const assinatura = await carregarAssinaturaAtualizada(id);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    res.json({
      ...mapearAssinatura(assinatura),
      servicos: await listarServicosDaAssinatura(id),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/publico/assinaturas/:id', requirePainelOuBridge, async (req, res) => {
  const { id } = req.params;
  const {
    diasFuncionamento,
    horarioAbertura,
    horarioAlmocoInicio,
    horarioAlmocoFim,
    horarioFechamento,
    localizacaoCidade,
    localizacaoRua,
    localizacaoReferencia,
    servicos,
  } = req.body;

  try {
    if (!assinaturaPertenceAoBarbeiro(req, res)) {
      return;
    }

    const assinatura = await carregarAssinaturaAtualizada(id);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    await runAsync(
      `UPDATE assinaturas
       SET dias_funcionamento = $1,
           horario_abertura = $2,
           horario_almoco_inicio = $3,
           horario_almoco_fim = $4,
           horario_fechamento = $5,
           localizacao_cidade = $6,
           localizacao_rua = $7,
           localizacao_referencia = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9`,
      [
        serializarDiasFuncionamento(diasFuncionamento),
        horarioAbertura || assinatura.horario_abertura || '08:00',
        horarioAlmocoInicio || assinatura.horario_almoco_inicio || '12:00',
        horarioAlmocoFim || assinatura.horario_almoco_fim || '13:00',
        horarioFechamento || assinatura.horario_fechamento || '18:00',
        String(localizacaoCidade || assinatura.localizacao_cidade || '').trim(),
        String(localizacaoRua || assinatura.localizacao_rua || '').trim(),
        String(localizacaoReferencia || assinatura.localizacao_referencia || '').trim(),
        id,
      ]
    );

    if (Array.isArray(servicos)) {
      const servicosValidos = servicos
        .map((item) => ({
          nome: String(item.nome || '').trim(),
          preco: Number(item.preco),
        }))
        .filter((item) => item.nome && Number.isFinite(item.preco) && item.preco > 0);

      if (!servicosValidos.length) {
        res.status(400).json({ error: 'Cadastre pelo menos um servico com preco valido.' });
        return;
      }

      await runAsync("DELETE FROM servicos_assinatura WHERE assinatura_id = $1", [id]);

      for (const servico of servicosValidos) {
        await runAsync(
          "INSERT INTO servicos_assinatura (assinatura_id, nome, preco) VALUES ($1, $2, $3)",
          [id, servico.nome, servico.preco]
        );
      }
    }

    res.json(await montarRespostaAssinatura(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/publico/assinaturas/:id/whatsapp/status', requireBarbeiro, async (req, res) => {
  const { id } = req.params;
  console.info('[WHATSAPP] Buscando status da assinatura:', id);
  res.set('Cache-Control', 'no-store');
  try {
    if (!assinaturaPertenceAoBarbeiro(req, res)) return;
    const assinatura = await carregarAssinaturaAtualizada(id);
    if (!assinatura) throw createEvolutionError('Nao foi possivel localizar a assinatura.', 404, 'SUBSCRIPTION_NOT_FOUND');
    const sessao = usarEvolutionWhatsapp()
      ? await consultarStatusWhatsappEvolution(assinatura)
      : await consultarStatusWhatsappLocal(Number(id));
    if (!sessao.success) throw Object.assign(createEvolutionError(sessao.message, sessao.httpStatus || 502, sessao.errorCode), { rateLimitSource: sessao.rateLimitSource, upstreamStatus: sessao.upstreamStatus, retryAfterSeconds: sessao.retryAfterSeconds, retryAt: sessao.retryAt });
    const status = sessao.conectado ? 'connected' : sessao.connectionAttemptActive || ['iniciando', 'qr_pronto'].includes(sessao.status) ? 'pairing' : 'disconnected';
    console.info('[WHATSAPP] Estado da conexao:', { assinaturaId: id, status });
    res.json({ ...sessao, status });
  } catch (error) {
    logEvolutionError(`Erro ao consultar status do WhatsApp da assinatura ${id}`, error);
    responderErroWhatsapp(res, error);
  }
});

router.delete('/publico/assinaturas/:id/whatsapp/logout', requireBarbeiro, async (req, res) => {
  const { id } = req.params;

  try {
    if (!assinaturaPertenceAoBarbeiro(req, res)) {
      return;
    }

    const assinatura = await carregarAssinaturaAtualizada(id);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const instanceName = String(assinatura.whatsapp_session || '').trim();

    if (!instanceName) {
      res.json(
        respostaStatusWhatsapp({
          status: 'nao_configurado',
          instancia: null,
          conectado: false,
          precisaQr: true,
          mensagem: 'Nao havia sessao ativa para desconectar.',
        })
      );
      return;
    }

    await compartilharGeracaoQr(instanceName, async () => {
      try { await desconectarInstancia(instanceName); }
      catch (error) { if (!['EVOLUTION_INSTANCE_NOT_FOUND', 'EVOLUTION_ALREADY_DISCONNECTED'].includes(error.code)) throw error; }
    }, 'logout');
    await persistirSessaoWhatsapp(id, {
      whatsappStatus: 'nao_configurado',
    });

    res.json(
      respostaStatusWhatsapp({
        status: 'nao_configurado',
        instancia: instanceName,
        conectado: false,
        precisaQr: true,
        mensagem: 'WhatsApp desconectado com sucesso.',
      })
    );
  } catch (error) {
    logEvolutionError(`logout do whatsapp da assinatura ${id}`, error);
    responderErroWhatsapp(res, error);
  }
});

router.post('/admin/login', async (req, res) => {
  const email = normalizarEmail(req.body?.email || '');
  const senha = String(req.body?.senha || '');

  if (!email || !senha) {
    res.status(400).json({ error: 'Gmail e senha do admin sao obrigatorios.' });
    return;
  }

  try {
    if (!credenciaisAdminConfiguradas()) {
      res.status(503).json({ error: 'Credenciais do admin nao configuradas neste ambiente.' });
      return;
    }

    if (email !== normalizarEmail(ADMIN_EMAIL) || senha !== ADMIN_PASSWORD) {
      res.status(401).json({ error: 'Gmail ou senha do admin invalidos.' });
      return;
    }

    const token = crypto.randomBytes(24).toString('hex');
    adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);

    res.json({ token, expiresInHours: 12 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/admin/assinatura-config', requireAdmin, async (req, res) => {
  try {
    const suporteNumero = await getConfiguracao('suporte_numero');

    res.json({
      suporteNumero,
      valorMensal: VALOR_MENSAL_PADRAO,
      gateway: { provider: 'mercado_pago', label: 'Mercado Pago', enabled: payments.configured() },
      plan: PROFESSIONAL_PLAN,
      pix: null,
      mensagemCobranca: MENSAGEM_COBRANCA_PADRAO,
      diasVencimento: DIAS_VENCIMENTO,
      metodosPagamento: METODOS_PAGAMENTO,
      statusDisponiveis: STATUS_ASSINATURA,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/admin/assinatura-config', requireAdmin, async (req, res) => {
  const suporteNumero = String(req.body?.suporteNumero || '').trim();

  if (!suporteNumero) {
    res.status(400).json({ error: 'Numero de suporte e obrigatorio.' });
    return;
  }

  try {
    await runAsync(
      `INSERT INTO configuracoes (chave, valor)
       VALUES ('suporte_numero', $1)
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
      [suporteNumero]
    );

    await runAsync(
      `UPDATE assinaturas
       SET suporte_numero = $1,
           updated_at = CURRENT_TIMESTAMP`,
      [suporteNumero]
    );

    res.json({ suporteNumero });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/admin/mercadopago/diagnostico/:preferenceId', requireAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const preferenceId = req.params.preferenceId;
  if (!/^[a-zA-Z0-9-]{1,150}$/.test(preferenceId)) return res.status(400).json({ error: 'Preferencia invalida.' });
  try {
    const order = await getAsync(`SELECT o.*, s.email FROM mercado_pago_orders o
      JOIN assinaturas s ON s.id=o.assinatura_id WHERE o.preference_id=$1`, [preferenceId]);
    if (!order) return res.status(404).json({ error: 'Preferencia nao encontrada neste sistema.' });
    res.json(await require('./services/payments/diagnostics').diagnose(order));
  } catch {
    res.status(503).json({ error: 'Nao foi possivel consultar o diagnostico.' });
  }
});

router.get('/admin/assinaturas', requireAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const grupos = await listarAssinaturasComServicos();
    const withConfirmation = assinatura => ({ ...assinatura,
      deleteConfirmationToken: assinaturaDeleteToken(assinatura, req.headers['x-admin-token']),
    });
    const assinaturas = grupos.assinaturas.map(withConfirmation);
    if (req.query.incluirPendentes === '1') {
      return res.json({ assinaturas, pendentes: grupos.pendentes.map(withConfirmation) });
    }
    res.json(assinaturas);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/admin/assinaturas/por-email', requireAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const email = normalizarEmail(req.query.email);
  if (typeof req.query.email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Informe o e-mail completo do cliente.' });
  }
  try {
    const accounts = await allAsync(`SELECT id, barbearia_nome, email FROM assinaturas
      WHERE LOWER(BTRIM(email))=$1 LIMIT 2`, [email]);
    if (!accounts.length) return res.status(404).json({ error: 'Nenhum cadastro encontrado para este e-mail.' });
    if (accounts.length > 1) return res.status(409).json({ error: 'Mais de um cadastro usa este e-mail. Confira os cadastros antes de liberar.' });
    res.json(accounts[0]);
  } catch {
    res.status(500).json({ error: 'Nao foi possivel consultar o cadastro.' });
  }
});

router.post('/admin/assinaturas/:id/liberar-dias', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const dias = req.body?.dias;
  if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(id) ||
      !Number.isInteger(dias) || dias < 1 || dias > 365) {
    return res.status(400).json({ error: 'Informe uma conta valida e de 1 a 365 dias inteiros.' });
  }
  try {
    const result = await db.transaction(async connection => {
      const account = await connection.getAsync('SELECT id, acesso_manual_ate FROM assinaturas WHERE id=$1 FOR UPDATE', [id]);
      if (!account) return null;
      const ate = new Date(Math.max(Date.now() + dias * 86400000, Date.parse(account.acesso_manual_ate || '') || 0)).toISOString();
      await connection.runAsync(`UPDATE assinaturas SET acesso_manual_ate=$1,
        observacoes=concat_ws(E'\\n', NULLIF(observacoes,''), $2::text), updated_at=CURRENT_TIMESTAMP WHERE id=$3`,
      [ate, `Liberacao administrativa sem pagamento: ${dias} dia(s) a partir de agora, ate ${ate}.`, id]);
      return { sucesso: true, id, acesso_manual_ate: ate };
    });
    if (!result) return res.status(404).json({ error: 'Conta nao encontrada.' });
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Nao foi possivel liberar o acesso. Tente novamente.' });
  }
});

router.patch('/admin/assinaturas/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, observacoes } = req.body;

  if (!STATUS_ASSINATURA.includes(status)) {
    res.status(400).json({ error: 'Status invalido.' });
    return;
  }

  if (['ativo', 'ativa', 'atrasada'].includes(status)) {
    return res.status(400).json({ error: 'Para liberar acesso, consulte um pagamento aprovado pelo Mercado Pago.' });
  }

  try {
    const assinatura = await getAsync("SELECT * FROM assinaturas WHERE id = $1", [id]);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const proximoVencimento = assinatura.proximo_vencimento;

    await runAsync(
      `UPDATE assinaturas
       SET status = $1,
           acesso_manual_ate = NULL,
           ultimo_pagamento = $2,
           proximo_vencimento = $3,
           observacoes = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [
        status,
        assinatura.ultimo_pagamento || null,
        proximoVencimento,
        observacoes || assinatura.observacoes || '',
        id,
      ]
    );

    res.json(await montarRespostaAssinatura(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/admin/assinaturas/:id/confirmar-pagamento', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const paymentId = String(req.body?.paymentId || '');
    if (!/^\d+$/.test(paymentId)) return res.status(400).json({ error: 'Informe paymentId do Mercado Pago para verificar o pagamento.' });
    await payments.reconcile(paymentId, Number(id));
    res.json(await montarRespostaAssinatura(id));
  } catch (error) {
    res.status(error.statusCode || 503).json({ error: error.publicMessage || 'Falha ao consultar pagamento no Mercado Pago.' });
  }
});

router.post('/admin/assinaturas/:id/bloquear', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const observacoes = String(req.body?.observacoes || '').trim();

  try {
    const assinatura = await getAsync("SELECT * FROM assinaturas WHERE id = $1", [id]);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    await runAsync(
      `UPDATE assinaturas
       SET status = 'bloqueado',
           acesso_manual_ate = NULL,
           observacoes = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [observacoes || assinatura.observacoes || '', id]
    );

    res.json(await montarRespostaAssinatura(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
