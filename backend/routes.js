const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');

const db = require('./database');
const { criarCliente: criarClienteAsaas, criarAssinatura: criarAssinaturaAsaas } = require('./asaas');
const {
  getEvolutionConfig,
  createEvolutionError,
  logEvolutionError,
  gerarNomeInstancia,
  extrairConteudoQr,
  construirQrCodeUrl,
  validarConexaoApi,
  buscarInstancia,
  criarInstancia,
  conectarInstancia,
  obterEstadoConexao,
  desconectarInstancia,
} = require('./evolutionApi');

const router = express.Router();
const DIAS_VENCIMENTO = [5, 12, 24];
const METODOS_PAGAMENTO = ['pix'];
const STATUS_ASSINATURA = ['pendente', 'ativo', 'bloqueado'];
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BARBER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MERCADO_PAGO_API_BASE_URL = 'https://api.mercadopago.com';
const VALOR_MENSAL_PADRAO = 65;
const TOLERANCIA_ATRASO_DIAS = 3;
const MENSAGEM_COMPROVANTE_WHATSAPP = 'Ola, acabei de fazer o pagamento e estou enviando o comprovante.';
const MENSAGEM_COBRANCA_PADRAO = 'Seu pagamento venceu, favor regularizar para evitar bloqueio.';
const PIX_CONFIG = {
  chave: '11906363528',
  chaveExibicao: '11906363528',
  favorecido: 'Gabriel Messias Rios',
  cidade: 'SAO PAULO',
  copiaColaFixo: '11906363528',
  qrCodeImageUrl: '/assets/pix-qr-fixo.png',
};
const ADMIN_EMAIL = 'gabriel0009messias@gmail.com';
const ADMIN_PASSWORD = 'rios123456';
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

function calcularPrimeiroVencimento() {
  const hoje = new Date();
  return formatarDataISO(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 1));
}

function obterClienteSaasId(req) {
  const headerId = req.headers['x-cliente-id'];
  const bodyId = req.body?.id || req.body?.clienteId;
  const queryId = req.query?.id || req.query?.clienteId;
  const valor = headerId || bodyId || queryId;
  const id = Number.parseInt(valor, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function verificarAssinatura(req, res, next) {
  const clienteId = obterClienteSaasId(req);

  if (!clienteId) {
    res.status(400).json({ error: 'Informe o id do cliente em x-cliente-id, body.clienteId ou query.clienteId.' });
    return;
  }

  try {
    const cliente = await getAsync('SELECT * FROM clientes_saas WHERE id = ?', [clienteId]);

    if (!cliente) {
      res.status(404).json({ error: 'Cliente nao encontrado.' });
      return;
    }

    if (cliente.status !== 'ativo') {
      res.status(403).json({ error: 'Sistema bloqueado por falta de pagamento' });
      return;
    }

    req.clienteSaas = cliente;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

router.post('/criar-cliente', async (req, res) => {
  const nome = String(req.body?.nome || '').trim();
  const cpf = String(req.body?.cpf || '').trim();
  const email = String(req.body?.email || '').trim();
  const telefone = String(req.body?.telefone || '').trim();

  if (!nome || !cpf || !email || !telefone) {
    res.status(400).json({ error: 'Informe nome, cpf, email e telefone.' });
    return;
  }

  try {
    const clienteAsaas = await criarClienteAsaas({ nome, cpf, email, telefone });

    const resultado = await db.runAsync(
      `INSERT INTO clientes_saas (
        nome,
        cpf,
        email,
        telefone,
        asaas_customer_id,
        status
      ) VALUES (?, ?, ?, ?, ?, 'ativo')`,
      [nome, cpf, email, telefone, clienteAsaas.id]
    );

    const clienteSalvo = await db.getAsync('SELECT * FROM clientes_saas WHERE id = ?', [resultado.lastID]);

    res.status(201).json({
      message: 'Cliente criado com sucesso no Asaas.',
      cliente: clienteSalvo,
      asaas: clienteAsaas,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: 'Erro ao criar cliente no Asaas.',
      details: error.message,
    });
  }
});

router.post('/criar-assinatura', async (req, res) => {
  const clienteId = Number.parseInt(req.body?.clienteId, 10);
  const asaasCustomerId = String(req.body?.asaasCustomerId || '').trim();
  const nextDueDate = String(req.body?.nextDueDate || calcularPrimeiroVencimento()).trim();

  if (!clienteId && !asaasCustomerId) {
    res.status(400).json({ error: 'Informe clienteId local ou asaasCustomerId.' });
    return;
  }

  try {
    const cliente = clienteId
      ? await db.getAsync('SELECT * FROM clientes_saas WHERE id = ?', [clienteId])
      : await db.getAsync('SELECT * FROM clientes_saas WHERE asaas_customer_id = ?', [asaasCustomerId]);

    if (!cliente) {
      res.status(404).json({ error: 'Cliente nao encontrado para criar assinatura.' });
      return;
    }

    const assinaturaAsaas = await criarAssinaturaAsaas({
      customer: cliente.asaas_customer_id,
      nextDueDate,
    });

    await db.runAsync(
      `UPDATE clientes_saas
       SET asaas_subscription_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [assinaturaAsaas.id, cliente.id]
    );

    const clienteAtualizado = await db.getAsync('SELECT * FROM clientes_saas WHERE id = ?', [cliente.id]);

    console.log('[Pagamento] Assinatura mensal criada no Asaas:', {
      clienteId: cliente.id,
      asaasCustomerId: cliente.asaas_customer_id,
      subscriptionId: assinaturaAsaas.id,
      valor: 65,
      ciclo: 'MONTHLY',
      formaPagamento: 'PIX',
    });

    res.status(201).json({
      message: 'Assinatura criada com sucesso.',
      cliente: clienteAtualizado,
      assinatura: assinaturaAsaas,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: 'Erro ao criar assinatura no Asaas.',
      details: error.message,
    });
  }
});

router.get('/sistema', verificarAssinatura, (req, res) => {
  res.json({
    message: 'Sistema liberado para cliente com assinatura ativa.',
    cliente: {
      id: req.clienteSaas.id,
      nome: req.clienteSaas.nome,
      status: req.clienteSaas.status,
    },
  });
});

// Endpoint para excluir assinatura (admin)
router.delete('/admin/assinaturas/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    // Remove serviços vinculados
    await runAsync('DELETE FROM servicos_assinatura WHERE assinatura_id = ?', [id]);
    // Remove a assinatura
    const result = await runAsync('DELETE FROM assinaturas WHERE id = ?', [id]);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Assinatura não encontrada.' });
      return;
    }
    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

  return {
    ...assinatura,
    nome: assinatura.barbearia_nome,
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

function criarPayloadPix(valor = VALOR_MENSAL_PADRAO) {
  return PIX_CONFIG.copiaColaFixo;
}

function obterDadosPix(valor = VALOR_MENSAL_PADRAO, suporteNumero = '') {
  const copiaCola = criarPayloadPix(valor);

  return {
    chave: PIX_CONFIG.chave,
    chaveExibicao: PIX_CONFIG.chaveExibicao,
    favorecido: PIX_CONFIG.favorecido,
    valor: Number(valor),
    copiaCola,
    qrCodeImageUrl: PIX_CONFIG.qrCodeImageUrl,
    instrucoes: 'Apos o pagamento, envie o comprovante no WhatsApp',
    mensagemWhatsapp: MENSAGEM_COMPROVANTE_WHATSAPP,
    whatsappLink: criarLinkWhatsApp(suporteNumero, MENSAGEM_COMPROVANTE_WHATSAPP),
  };
}

function calcularResumoPagamento(assinatura) {
  if (!assinatura?.proximo_vencimento) {
    return {
      diasAtraso: 0,
      atrasado: false,
      venceHoje: false,
      bloqueiaHoje: false,
      statusSugerido: assinatura?.status || 'pendente',
      indicadorAtraso: 'Sem vencimento definido',
      mensagemAdmin: 'Sem vencimento definido.',
      mensagemCliente: 'Pagamento pendente. Aguarde a confirmacao manual do admin.',
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

  let statusSugerido = assinatura.status;

  if (assinatura.status !== 'bloqueado') {
    if (bloqueadoAutomatico) {
      statusSugerido = 'bloqueado';
    } else if (venceHoje || atrasado) {
      statusSugerido = 'pendente';
    }
  }

  let indicadorAtraso = 'Em dia';
  let mensagemAdmin = 'Pagamento em dia.';
  let mensagemCliente = 'Seu acesso esta ativo.';

  if (bloqueadoAutomatico) {
    indicadorAtraso = `${diasAtraso} dias atrasado`;
    mensagemAdmin = `Pagamento atrasado ha ${diasAtraso} dias. Cliente deve permanecer bloqueado ate confirmacao manual.`;
    mensagemCliente = 'Seu acesso foi bloqueado por pagamento pendente.';
  } else if (bloqueiaHoje) {
    indicadorAtraso = '3 dias (bloquear hoje)';
    mensagemAdmin = 'Cliente com 3 dias de atraso. Se nao houver pagamento confirmado, bloqueie hoje.';
    mensagemCliente = 'Seu pagamento esta com 3 dias de atraso. Regularize hoje para evitar bloqueio.';
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
    mensagemAdmin = 'Pagamento vence hoje. Status deve ficar pendente ate a confirmacao manual.';
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
  if (!assinatura || !assinatura.proximo_vencimento) {
    return assinatura;
  }

  const resumo = calcularResumoPagamento(assinatura);

  if (resumo.statusSugerido !== assinatura.status) {
    await runAsync(
      `UPDATE assinaturas
       SET status = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [resumo.statusSugerido, assinatura.id]
    );

    return getAsync('SELECT * FROM assinaturas WHERE id = ?', [assinatura.id]);
  }

  return assinatura;
}

async function enriquecerAssinatura(assinatura) {
  const sincronizada = await sincronizarStatusPorVencimento(assinatura);

  if (!sincronizada) {
    return sincronizada;
  }

  const resumoPagamento = calcularResumoPagamento(sincronizada);
  const pix = obterDadosPix(sincronizada.valor_mensal || VALOR_MENSAL_PADRAO, sincronizada.suporte_numero);

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
  const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);
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

  if (assinatura.status === 'ativo') {
    return {
      liberado: true,
      motivo: 'assinatura_ativa',
      mensagem: 'Assinatura ativa.',
    };
  }

  if (assinatura.status === 'teste' || assinatura.status === 'pendente') {
    return {
      liberado: false,
      motivo: 'pagamento_pendente',
      mensagem:
        resumo.atrasado || resumo.venceHoje
          ? resumo.mensagemCliente
          : 'Pagamento pendente. Envie o comprovante e aguarde a confirmacao manual do admin.',
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
    status: assinatura.status,
    liberado: acesso.liberado,
    motivo: acesso.motivo,
    mensagem: acesso.mensagem,
    atraso: {
      dias: resumo.diasAtraso,
      indicador: resumo.indicadorAtraso,
      bloqueiaHoje: resumo.bloqueiaHoje,
    },
    pix: obterDadosPix(assinatura.valor_mensal || VALOR_MENSAL_PADRAO, assinatura.suporte_numero),
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
  const row = await getAsync('SELECT valor FROM configuracoes WHERE chave = ?', [chave]);
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
  const assinaturaOriginal = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [session.assinaturaId]);
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

  const assinaturaOriginal = await getAsync('SELECT * FROM assinaturas WHERE whatsapp_bridge_token = ?', [token]);
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
      res.status(401).json({ error: 'Login do barbeiro obrigatorio.' });
      return;
    }

    req.barbeiroToken = token;
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
     WHERE assinatura_id = ?
     ORDER BY id ASC`,
    [assinaturaId]
  );
}

async function listarAssinaturasComServicos() {
  const assinaturas = await allAsync(
    `SELECT *
     FROM assinaturas
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

  const detalhadas = await Promise.all(
    assinaturas.map(async (assinatura) => {
      const enriquecida = await enriquecerAssinatura(assinatura);

      return {
        ...enriquecida,
        servicos: await listarServicosDaAssinatura(assinatura.id),
      };
    })
  );

  return detalhadas;
}

async function montarRespostaAssinatura(assinaturaId) {
  const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [assinaturaId]);

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
    'SELECT id FROM servicos WHERE nome = ? AND preco = ? ORDER BY id ASC LIMIT 1',
    [nomeNormalizado, precoNormalizado]
  );

  if (servicoExistente?.id) {
    return servicoExistente.id;
  }

  const proximo = await getAsync('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM servicos');
  const novoId = Number(proximo?.id || 1);

  await runAsync('INSERT INTO servicos (id, nome, preco) VALUES (?, ?, ?)', [novoId, nomeNormalizado, precoNormalizado]);

  return novoId;
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

function emAmbienteHospedado() {
  return Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
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

function getMercadoPagoAccessToken() {
  return String(process.env.MP_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || '').trim();
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
     WHERE lower(email) = ?
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
  await runAsync('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE assinatura_id = ? AND used_at IS NULL', [
    assinaturaId,
  ]);

  await runAsync(
    `INSERT INTO password_reset_tokens (assinatura_id, token_hash, expires_at)
     VALUES (?, ?, ?)`,
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
     WHERE prt.token_hash = ?
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

async function requestMercadoPago(path, options = {}) {
  const accessToken = getMercadoPagoAccessToken();

  if (!accessToken) {
    const error = new Error('Mercado Pago ainda nao configurado. Adicione MP_ACCESS_TOKEN no servidor.');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(`${MERCADO_PAGO_API_BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = payload?.message || payload?.error || 'Falha ao falar com o Mercado Pago.';
    const error = new Error(detail);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function mapearStatusMercadoPagoParaAssinatura(status) {
  switch (String(status || '').toLowerCase()) {
    case 'authorized':
      return 'ativo';
    case 'pending':
    case 'in_process':
      return 'pendente';
    case 'paused':
    case 'cancelled':
      return 'bloqueado';
    default:
      return 'pendente';
  }
}

async function salvarRetornoMercadoPago(assinaturaId, preapproval) {
  const gatewayStatus = String(preapproval?.status || 'pending');
  const assinaturaStatus = mapearStatusMercadoPagoParaAssinatura(gatewayStatus);
  const proximoVencimento = String(preapproval?.next_payment_date || '').slice(0, 10) || null;
  const ultimoPagamento =
    assinaturaStatus === 'ativo' ? new Date().toISOString().slice(0, 10) : null;

  await runAsync(
    `UPDATE assinaturas
     SET status = ?,
         gateway_provider = 'mercado_pago',
         gateway_status = ?,
         gateway_external_reference = ?,
         gateway_checkout_url = ?,
         mercado_preapproval_id = ?,
         mercado_payer_email = ?,
         mercado_next_payment_date = ?,
         mercado_last_payload = ?,
         ultimo_pagamento = COALESCE(?, ultimo_pagamento),
         proximo_vencimento = COALESCE(?, proximo_vencimento),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      assinaturaStatus,
      gatewayStatus,
      preapproval?.external_reference || null,
      preapproval?.init_point || preapproval?.sandbox_init_point || null,
      preapproval?.id || null,
      preapproval?.payer_email || null,
      preapproval?.next_payment_date || null,
      JSON.stringify(preapproval || {}),
      ultimoPagamento,
      proximoVencimento,
      assinaturaId,
    ]
  );
}

function calcularStartDateAssinatura(diaVencimento) {
  const agora = new Date();
  const inicio = new Date(agora.getFullYear(), agora.getMonth(), Number(diaVencimento), 12, 0, 0);

  if (inicio.getTime() <= agora.getTime()) {
    inicio.setMonth(inicio.getMonth() + 1);
  }

  return inicio.toISOString();
}

async function criarCheckoutMercadoPagoParaAssinatura(assinatura, req) {
  if (!assinatura?.email) {
    const error = new Error('Informe um Gmail valido para gerar a assinatura no Mercado Pago.');
    error.statusCode = 400;
    throw error;
  }

  const appUrl = getPublicAppUrl(req);
  const externalReference = assinatura.gateway_external_reference || `assinatura-${assinatura.id}`;
  const preapproval = await requestMercadoPago('/preapproval', {
    method: 'POST',
    body: {
      reason: `Assinatura mensal Salãoflix - ${assinatura.barbearia_nome}`,
      payer_email: assinatura.email,
      external_reference: externalReference,
      back_url: `${appUrl}/cadastro.html?assinatura=${assinatura.id}&gateway=mercado_pago`,
      notification_url: `${appUrl}/api/mercadopago/webhook`,
      status: 'pending',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: Number(assinatura.valor_mensal || 1),
        currency_id: 'BRL',
        billing_day: Number(assinatura.dia_vencimento || 5),
        billing_day_proportional: false,
        start_date: calcularStartDateAssinatura(assinatura.dia_vencimento || 5),
      },
    },
  });

  await salvarRetornoMercadoPago(assinatura.id, preapproval);
  return preapproval;
}

function erroHorarioJaOcupado(error) {
  return error?.code === 'SQLITE_CONSTRAINT' || /unique|constraint/i.test(String(error?.message || ''));
}

function assinaturaPertenceAoBarbeiro(req, res) {
  if (Number(req.params.id) !== Number(req.assinatura.id)) {
    res.status(403).json({ error: 'Essa assinatura nao pertence a este login.' });
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

function agoraIso() {
  return new Date().toISOString();
}

function precisaGerarQrPorStatus(status = '') {
  return ['nao_configurado', 'close', 'closed', 'disconnected', 'logout'].includes(String(status || '').trim().toLowerCase());
}

function compartilharGeracaoQr(assinaturaId, executor) {
  if (whatsappQrJobs.has(assinaturaId)) {
    return whatsappQrJobs.get(assinaturaId);
  }

  const job = Promise.resolve()
    .then(executor)
    .finally(() => {
      if (whatsappQrJobs.get(assinaturaId) === job) {
        whatsappQrJobs.delete(assinaturaId);
      }
    });

  whatsappQrJobs.set(assinaturaId, job);
  return job;
}

async function validarEvolutionApiDisponivel() {
  await validarConexaoApi();
}

async function persistirSessaoWhatsapp(assinaturaId, valores = {}) {
  const campos = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappSession')) {
    campos.push('whatsapp_session = ?');
    params.push(valores.whatsappSession || null);
  }

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappStatus')) {
    campos.push('whatsapp_status = ?');
    params.push(valores.whatsappStatus || 'nao_configurado');
  }

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappUltimoErro')) {
    campos.push('whatsapp_ultimo_erro = ?');
    params.push(valores.whatsappUltimoErro || null);
  }

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappUltimoCheckEm')) {
    campos.push('whatsapp_ultimo_check_em = ?');
    params.push(valores.whatsappUltimoCheckEm || null);
  }

  if (Object.prototype.hasOwnProperty.call(valores, 'whatsappUltimoQrEm')) {
    campos.push('whatsapp_ultimo_qr_em = ?');
    params.push(valores.whatsappUltimoQrEm || null);
  }

  if (!campos.length) {
    return;
  }

  params.push(assinaturaId);

  await runAsync(
    `UPDATE assinaturas
     SET ${campos.join(', ')},
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
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

async function garantirInstanciaWhatsapp(assinatura) {
  const instanceName = String(assinatura?.whatsapp_session || '').trim() || gerarNomeInstancia(assinatura.id);

  await validarEvolutionApiDisponivel();

  const existente = await buscarInstancia(instanceName);

  if (existente?.instance?.instanceName) {
    if (instanceName !== assinatura?.whatsapp_session) {
      await persistirSessaoWhatsapp(assinatura.id, {
        whatsappSession: instanceName,
      });
    }

    return instanceName;
  }

  try {
    await criarInstancia(instanceName);
  } catch (error) {
    const statusCode = Number(error.statusCode || 0);
    const mensagem = String(error.message || '');

    if (statusCode !== 409 && !/already|exists|duplicate|duplicada|existe/i.test(mensagem)) {
      throw error;
    }
  }

  if (instanceName !== assinatura?.whatsapp_session) {
    await persistirSessaoWhatsapp(assinatura.id, {
      whatsappSession: instanceName,
    });
  }

  return instanceName;
}

async function consultarStatusWhatsappEvolution(assinatura) {
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
    await validarEvolutionApiDisponivel();
    const estado = await obterEstadoConexao(instanceName);
    const statusMapeado = mapearStatusWhatsappEvolution(estado?.instance?.state);

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
      return respostaStatusWhatsapp({
        status: statusMapeado,
        instancia: instanceName,
        conectado: false,
        precisaQr: false,
        mensagem: 'Conexao em andamento. Aguarde a confirmacao do WhatsApp.',
      });
    }

    return respostaStatusWhatsapp({
      status: statusMapeado,
      instancia: instanceName,
      conectado: false,
      precisaQr: precisaGerarQrPorStatus(statusMapeado),
      mensagem: 'A instancia existe, mas ainda precisa conectar o WhatsApp.',
    });
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
        mensagem: 'A sessao anterior do WhatsApp nao existe mais. Gere um novo QR Code.',
      });
    }

    await persistirSessaoWhatsapp(assinatura.id, {
      whatsappStatus: 'erro',
      whatsappUltimoErro: error.message || 'Falha ao consultar a Evolution API.',
      whatsappUltimoCheckEm: agoraIso(),
    });

    return respostaStatusWhatsapp({
      status: 'erro',
      ultimoErro: error.message,
      instancia: instanceName,
      conectado: false,
      precisaQr: false,
      mensagem: error.message,
    });
  }
}

async function gerarQrWhatsappEvolution(assinatura) {
  return compartilharGeracaoQr(assinatura.id, async () => {
    let ultimaFalha = null;

    for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
      try {
        const instanceName = await garantirInstanciaWhatsapp(assinatura);
        const estadoAtual = await consultarStatusWhatsappEvolution({
          ...assinatura,
          whatsapp_session: instanceName,
        });

        if (estadoAtual.conectado) {
          return respostaStatusWhatsapp({
            ...estadoAtual,
            status: 'success',
            qrCode: null,
            qr: null,
            precisaQr: false,
            mensagem: 'WhatsApp ja esta conectado. Nao foi necessario gerar um novo QR Code.',
          });
        }

        const conexao = await conectarInstancia(instanceName);
        const qrCode = construirQrCodeUrl(extrairConteudoQr(conexao));

        if (!qrCode) {
          throw createEvolutionError(
            'Nao foi possivel obter o QR Code da Evolution API. Tente novamente em alguns segundos.',
            502,
            'EVOLUTION_QR_EMPTY',
            conexao || null
          );
        }

        await persistirSessaoWhatsapp(assinatura.id, {
          whatsappSession: instanceName,
          whatsappStatus: 'qr_pronto',
          whatsappUltimoErro: null,
          whatsappUltimoCheckEm: agoraIso(),
          whatsappUltimoQrEm: agoraIso(),
        });

        return respostaStatusWhatsapp({
          status: 'success',
          qrCode,
          qr: qrCode,
          ultimoErro: null,
          instancia: instanceName,
          conectado: false,
          precisaQr: true,
          mensagem: 'Escaneie o QR Code com o WhatsApp para concluir a conexao.',
        });
      } catch (error) {
        ultimaFalha = error;
        logEvolutionError(`geracao de QR da assinatura ${assinatura.id} tentativa ${tentativa}/3`, error);

        await persistirSessaoWhatsapp(assinatura.id, {
          whatsappStatus: 'erro',
          whatsappUltimoErro: error.message || 'Falha ao gerar QR Code do WhatsApp.',
          whatsappUltimoCheckEm: agoraIso(),
        });

        if (error?.code === 'EVOLUTION_INSTANCE_NOT_FOUND') {
          await resetarSessaoWhatsapp(assinatura.id);
        }

        if (tentativa < 3) {
          await sleep(2000);
        }
      }
    }

    return respostaStatusWhatsapp({
      status: 'error',
      qrCode: null,
      qr: null,
      ultimoErro: ultimaFalha?.message || 'Falha ao gerar QR Code do WhatsApp.',
      instancia: String(assinatura?.whatsapp_session || '').trim() || null,
      conectado: false,
      precisaQr: false,
      mensagem: ultimaFalha?.message || 'Falha ao gerar QR Code do WhatsApp.',
    });
  });
}

router.get('/agendamentos', requirePainelOuBridge, (req, res) => {
  const query = `
    SELECT
      a.id,
      c.nome AS cliente,
      c.telefone,
      s.nome AS servico,
      s.preco,
      a.data,
      a.hora,
      a.status,
      a.lembrete_15_enviado_em,
      a.lembrete_7_enviado_em
    FROM agendamentos a
    LEFT JOIN clientes c ON c.id = a.cliente_id
    LEFT JOIN servicos s ON s.id = a.servico_id
    ORDER BY a.data ASC, a.hora ASC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.json(rows);
  });
});

router.post('/agendamentos', requirePainelOuBridge, async (req, res) => {
  const { cliente, telefone, servicoId, servicoNome, servicoPreco, data, hora } = req.body;

  if (!telefone || !data || !hora || (!servicoId && !servicoNome)) {
    res.status(400).json({ error: 'Cliente, telefone, servico, data e hora sao obrigatorios.' });
    return;
  }

  try {
    await runAsync('INSERT OR IGNORE INTO clientes (nome, telefone) VALUES (?, ?)', [cliente || telefone, telefone]);
    const clienteRow = await getAsync('SELECT id FROM clientes WHERE telefone = ?', [telefone]);

    if (!clienteRow?.id) {
      res.status(500).json({ error: 'Nao consegui localizar o cliente para salvar o agendamento.' });
      return;
    }

    const servicoIdFinal =
      servicoNome && Number.isFinite(Number(servicoPreco))
        ? await obterOuCriarServicoPadrao(servicoNome, servicoPreco)
        : Number(servicoId);

    if (!Number.isInteger(servicoIdFinal) || servicoIdFinal <= 0) {
      res.status(400).json({ error: 'Servico invalido para salvar o agendamento.' });
      return;
    }

    const resultado = await runAsync(
      'INSERT INTO agendamentos (cliente_id, servico_id, data, hora, status) VALUES (?, ?, ?, ?, ?)',
      [clienteRow.id, servicoIdFinal, data, hora, 'confirmado']
    );

    res.status(201).json({
      id: resultado.lastID,
      cliente: cliente || telefone,
      telefone,
      servicoId: servicoIdFinal,
      data,
      hora,
      status: 'confirmado',
    });
  } catch (error) {
    if (erroHorarioJaOcupado(error)) {
      res.status(409).json({ error: 'Esse horario ja foi agendado por outro cliente e nao esta mais disponivel.' });
      return;
    }

    res.status(500).json({ error: error.message });
  }
});

router.delete('/agendamentos/:id', requirePainelOuBridge, (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM agendamentos WHERE id = ?', [id], function onDelete(err) {
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
       SET lembrete_15_enviado_em = ?
       WHERE id = ?
         AND lembrete_15_enviado_em IS NULL`,
      [enviadoEm, id]
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
       SET lembrete_7_enviado_em = ?
       WHERE id = ?
         AND lembrete_7_enviado_em IS NULL`,
      [enviadoEm, id]
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
    SELECT SUM(s.preco) AS total
    FROM agendamentos a
    JOIN servicos s ON a.servico_id = s.id
    WHERE a.status = 'confirmado'
  `;

  if (periodo === 'dia') {
    query += " AND date(a.data) = date('now')";
  }

  if (periodo === 'mes') {
    query += " AND strftime('%m-%Y', a.data) = strftime('%m-%Y', 'now')";
  }

  if (periodo === 'ano') {
    query += " AND strftime('%Y', a.data) = strftime('%Y', 'now')";
  }

  db.get(query, [], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.json({ total: row?.total || 0 });
  });
});

router.get('/bloqueios', requirePainelOuBridge, (req, res) => {
  db.all('SELECT * FROM bloqueios ORDER BY data ASC, hora ASC', [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.json(rows);
  });
});

router.post('/bloqueios', requirePainelOuBridge, (req, res) => {
  const { data, hora } = req.body;

  if (!data || !hora) {
    res.status(400).json({ error: 'Data e hora sao obrigatorias.' });
    return;
  }

  db.run('INSERT INTO bloqueios (data, hora) VALUES (?, ?)', [data, hora], function onInsert(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.status(201).json({ id: this.lastID, data, hora });
  });
});

router.delete('/bloqueios/:id', requirePainelOuBridge, (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM bloqueios WHERE id = ?', [id], function onDelete(err) {
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
    const pix = obterDadosPix(VALOR_MENSAL_PADRAO, suporteNumero);

    res.json({
      suporteNumero,
      valorMensal: VALOR_MENSAL_PADRAO,
      whatsappBridgeUrl: null,
      whatsappLocalOnly: false,
      whatsappProvider: evolution.enabled ? 'evolution_api' : 'indisponivel',
      whatsappEnabled: evolution.enabled,
      whatsappSetupMessage: evolution.enabled
        ? ''
        : 'Configure EVOLUTION_API_URL e EVOLUTION_API_KEY no servidor para liberar o QR Code do WhatsApp.',
      whatsappRetry: {
        attempts: evolution.retryAttempts,
        delayMs: evolution.retryDelayMs,
        timeoutMs: evolution.timeoutMs,
      },
      gateway: null,
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

router.get('/publico/pix/chave', (req, res) => {
  res.json({ chave: PIX_CONFIG.chave, tipo: 'cpf' });
});

router.post('/publico/pix/qrcode', async (req, res) => {
  const { valor, descricao } = req.body;
  const pix = obterDadosPix(valor || VALOR_MENSAL_PADRAO);
  res.json({
    payload: pix.copiaCola,
    qrCodeImageUrl: pix.qrCodeImageUrl,
    valor: Number(valor || VALOR_MENSAL_PADRAO),
    descricao,
  });
});

router.post('/mercadopago/webhook', async (req, res) => {
  try {
    const resourceId = req.body?.data?.id || req.query['data.id'] || req.body?.id || req.query.id || null;

    if (!resourceId) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const preapproval = await requestMercadoPago(`/preapproval/${resourceId}`);
    const externalReference = String(preapproval?.external_reference || '');
    const assinaturaId = Number.parseInt(externalReference.replace('assinatura-', ''), 10);

    if (!assinaturaId) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    await salvarRetornoMercadoPago(assinaturaId, preapproval);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook Mercado Pago:', error.message);
    res.status(200).json({ ok: true });
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
    const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const preapproval = await criarCheckoutMercadoPagoParaAssinatura(assinatura, req);

    res.json({
      checkoutUrl: preapproval.init_point || preapproval.sandbox_init_point || null,
      gatewayStatus: preapproval.status || 'pending',
      provider: 'mercado_pago',
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
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
       WHERE telefone = ?
          OR whatsapp_numero = ?
          OR email = ?
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
        'Recuperacao por Gmail ainda nao esta configurada neste servidor. Adicione GMAIL_USER e GMAIL_APP_PASSWORD no servidor.'
      );
      error.statusCode = 501;
      throw error;
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
      await runAsync('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [recovery.id]);
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
      await runAsync('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [recovery.id]);
      res.status(410).json({ error: 'Esse link de recuperacao expirou.' });
      return;
    }

    const credenciais = criarCredenciaisSenha(novaSenha);

    await runAsync(
      `UPDATE assinaturas
       SET senha_hash = ?,
           senha_salt = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [credenciais.hash, credenciais.salt, recovery.assinatura_id]
    );

    await runAsync('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [recovery.id]);

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
       WHERE telefone = ?
          OR whatsapp_numero = ?
          OR (email <> '' AND email = ?)
          OR barbearia_nome = ?
       LIMIT 1`,
      [telefone, whatsappNumero || telefone, email || '', barbeariaNome]
    );

    if (assinaturaExistente) {
      if (!assinaturaExistente.senha_hash || !assinaturaExistente.senha_salt) {
        const credenciais = criarCredenciaisSenha(senha);

        await runAsync(
          `UPDATE assinaturas
           SET barbearia_nome = ?,
               responsavel_nome = ?,
               telefone = ?,
               email = ?,
               metodo_pagamento = ?,
               dia_vencimento = ?,
               whatsapp_numero = ?,
               dias_funcionamento = ?,
               horario_abertura = ?,
               horario_almoco_inicio = ?,
               horario_almoco_fim = ?,
               horario_fechamento = ?,
               status = CASE WHEN status = 'ativo' THEN 'ativo' ELSE 'pendente' END,
               senha_hash = ?,
               senha_salt = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            barbeariaNome,
            responsavelNome,
            telefone,
            email || '',
            metodoPagamento,
            dia,
            whatsappNumero || telefone,
            serializarDiasFuncionamento(diasFuncionamento),
            horarioAbertura || '08:00',
            horarioAlmocoInicio || '12:00',
            horarioAlmocoFim || '13:00',
            horarioFechamento || '18:00',
            credenciais.hash,
            credenciais.salt,
            assinaturaExistente.id,
          ]
        );

        await runAsync('DELETE FROM servicos_assinatura WHERE assinatura_id = ?', [assinaturaExistente.id]);

        for (const servico of servicosValidos) {
          await runAsync(
            'INSERT INTO servicos_assinatura (assinatura_id, nome, preco) VALUES (?, ?, ?)',
            [assinaturaExistente.id, servico.nome, servico.preco]
          );
        }

        const assinaturaAtualizada = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [assinaturaExistente.id]);
        const assinaturaCompleta = await montarRespostaAssinatura(assinaturaExistente.id);

        res.status(200).json({
          mensagem: 'Cadastro atualizado. Pagamento via Pix pendente de confirmacao manual no admin.',
          pix: assinaturaCompleta.pix,
          assinatura: assinaturaCompleta,
        });
        return;
      }

      res.status(409).json({
        error: 'Essa barbearia ja possui assinatura registrada. Regularize o Pix para liberar o acesso.',
      });
      return;
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
        senha_salt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ]
    );

    for (const servico of servicosValidos) {
      await runAsync(
        'INSERT INTO servicos_assinatura (assinatura_id, nome, preco) VALUES (?, ?, ?)',
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
      mensagem: 'Cadastro concluido. Pagamento via Pix pendente de confirmacao manual no admin.',
      pix: assinaturaCriada.pix,
      assinatura: assinaturaCriada,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
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
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.get('/publico/assinaturas/:id/whatsapp/qr', requireBarbeiro, async (req, res) => {
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

    const resultado = await gerarQrWhatsappEvolution(assinatura);
    res.json(resultado);
  } catch (error) {
    logEvolutionError(`endpoint qr da assinatura ${id}`, error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.get('/whatsapp/qr', requireBarbeiro, async (req, res) => {
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

    const resultado = await gerarQrWhatsappEvolution(assinatura);
    res.json({
      status: resultado.status === 'error' ? 'error' : 'success',
      qr: resultado.qr || resultado.qrCode || null,
      message: resultado.mensagem || '',
      conectado: Boolean(resultado.conectado),
    });
  } catch (error) {
    logEvolutionError(`endpoint /whatsapp/qr da assinatura ${req.assinatura?.id || 'desconhecida'}`, error);
    res.status(error.statusCode || 500).json({
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

    const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const bridgeToken = assinatura.whatsapp_bridge_token || crypto.randomBytes(24).toString('hex');

    if (bridgeToken !== assinatura.whatsapp_bridge_token) {
      await runAsync(
        `UPDATE assinaturas
         SET whatsapp_bridge_token = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
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
       SET dias_funcionamento = ?,
           horario_abertura = ?,
           horario_almoco_inicio = ?,
           horario_almoco_fim = ?,
           horario_fechamento = ?,
           localizacao_cidade = ?,
           localizacao_rua = ?,
           localizacao_referencia = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
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

      await runAsync('DELETE FROM servicos_assinatura WHERE assinatura_id = ?', [id]);

      for (const servico of servicosValidos) {
        await runAsync(
          'INSERT INTO servicos_assinatura (assinatura_id, nome, preco) VALUES (?, ?, ?)',
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

  try {
    if (!assinaturaPertenceAoBarbeiro(req, res)) {
      return;
    }

    const assinatura = await carregarAssinaturaAtualizada(id);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const sessao = await consultarStatusWhatsappEvolution(assinatura);
    res.json(sessao);
  } catch (error) {
    logEvolutionError(`status do whatsapp da assinatura ${id}`, error);
    res.status(error.statusCode || 500).json({ error: error.message });
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

    await validarEvolutionApiDisponivel();
    await desconectarInstancia(instanceName);
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
    res.status(error.statusCode || 500).json({ error: error.message });
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
      gateway: null,
      pix: obterDadosPix(VALOR_MENSAL_PADRAO, suporteNumero),
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
  const { suporteNumero } = req.body;

  if (!suporteNumero) {
    res.status(400).json({ error: 'Numero de suporte e obrigatorio.' });
    return;
  }

  try {
    await runAsync(
      `INSERT INTO configuracoes (chave, valor)
       VALUES ('suporte_numero', ?)
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
      [suporteNumero]
    );

    res.json({ suporteNumero });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/admin/assinaturas', requireAdmin, async (req, res) => {
  try {
    res.json(await listarAssinaturasComServicos());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/admin/assinaturas/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, ultimoPagamento, observacoes } = req.body;

  if (!STATUS_ASSINATURA.includes(status)) {
    res.status(400).json({ error: 'Status invalido.' });
    return;
  }

  try {
    const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const referenciaPagamento = ultimoPagamento ? criarDataLocal(ultimoPagamento) : new Date();
    const proximoVencimento =
      status === 'ativo'
        ? calcularProximoVencimento(assinatura.dia_vencimento, referenciaPagamento)
        : assinatura.proximo_vencimento;

    await runAsync(
      `UPDATE assinaturas
       SET status = ?,
           ultimo_pagamento = ?,
           proximo_vencimento = ?,
           observacoes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        status,
        ultimoPagamento || assinatura.ultimo_pagamento || null,
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
  const dataPagamento = String(req.body?.dataPagamento || '').trim() || new Date().toISOString().slice(0, 10);
  const observacoes = String(req.body?.observacoes || '').trim();

  try {
    const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    const referenciaPagamento = criarDataLocal(dataPagamento) || new Date();
    const proximoVencimento = formatarDataISO(
      new Date(referenciaPagamento.getFullYear(), referenciaPagamento.getMonth(), referenciaPagamento.getDate() + 30)
    );

    await runAsync(
      `UPDATE assinaturas
       SET status = 'ativo',
           ultimo_pagamento = ?,
           proximo_vencimento = ?,
           observacoes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [dataPagamento, proximoVencimento, observacoes || assinatura.observacoes || '', id]
    );

    res.json(await montarRespostaAssinatura(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/admin/assinaturas/:id/bloquear', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const observacoes = String(req.body?.observacoes || '').trim();

  try {
    const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);

    if (!assinatura) {
      res.status(404).json({ error: 'Assinatura nao encontrada.' });
      return;
    }

    await runAsync(
      `UPDATE assinaturas
       SET status = 'bloqueado',
           observacoes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [observacoes || assinatura.observacoes || '', id]
    );

    res.json(await montarRespostaAssinatura(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
