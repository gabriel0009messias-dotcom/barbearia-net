const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');

const db = require('./database');
const { iniciarSessao, statusSessao } = require('./whatsappManager');

const router = express.Router();
const DIAS_VENCIMENTO = [5, 12, 24];
const METODOS_PAGAMENTO = ['cartao', 'pix'];
const STATUS_ASSINATURA = ['pendente', 'ativo', 'bloqueado'];
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BARBER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MERCADO_PAGO_API_BASE_URL = 'https://api.mercadopago.com';
const adminSessions = new Map();
const barberSessions = new Map();
const passwordRecoveryRequests = new Map();
const DIAS_SEMANA = [
  { value: 0, label: 'Domingo' },
  { value: 1, label: 'Segunda-feira' },
  { value: 2, label: 'Terca-feira' },
  { value: 3, label: 'Quarta-feira' },
  { value: 4, label: 'Quinta-feira' },
  { value: 5, label: 'Sexta-feira' },
  { value: 6, label: 'Sabado' },
];

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
    dias_funcionamento: desserializarDiasFuncionamento(assinatura.dias_funcionamento),
  };
}

function criarLembretePagamento(assinatura) {
  if (!assinatura?.proximo_vencimento) {
    return null;
  }

  const hoje = new Date();
  const vencimento = criarDataLocal(assinatura.proximo_vencimento);

  if (!vencimento) {
    return null;
  }

  const diasParaVencer = calcularDiferencaEmDias(hoje, vencimento);

  if (diasParaVencer < 0) {
    return {
      tipo: 'atrasado',
      diasParaVencer,
      mensagem: `Seu pagamento venceu em ${assinatura.proximo_vencimento}. Regularize a assinatura para desbloquear o sistema.`,
    };
  }

  if (diasParaVencer === 0) {
    return {
      tipo: 'hoje',
      diasParaVencer,
      mensagem: `Sua assinatura vence hoje, dia ${String(assinatura.dia_vencimento).padStart(2, '0')}. Pague hoje para nao bloquear o acesso.`,
    };
  }

  if (diasParaVencer <= 3) {
    return {
      tipo: 'proximo',
      diasParaVencer,
      mensagem: `Sua assinatura vence em ${diasParaVencer} dia${diasParaVencer === 1 ? '' : 's'}, no dia ${String(
        assinatura.dia_vencimento
      ).padStart(2, '0')}.`,
    };
  }

  return null;
}

async function sincronizarStatusPorVencimento(assinatura) {
  if (!assinatura || assinatura.status !== 'ativo' || !assinatura.proximo_vencimento) {
    return assinatura;
  }

  const hoje = new Date();
  const vencimento = criarDataLocal(assinatura.proximo_vencimento);

  if (!vencimento) {
    return assinatura;
  }

  const diasParaVencer = calcularDiferencaEmDias(hoje, vencimento);

  if (diasParaVencer <= 0) {
    await runAsync(
      `UPDATE assinaturas
       SET status = 'bloqueado',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [assinatura.id]
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

  return {
    ...mapearAssinatura(sincronizada),
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
      mensagem: 'Pagamento pendente. Regularize sua assinatura para liberar o sistema.',
    };
  }

  return {
    liberado: false,
    motivo: 'bloqueado',
    mensagem: 'Sistema bloqueado. Regularize sua assinatura para voltar a usar o sistema.',
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
    res.status(error.statusCode || 500).json({ error: error.message });
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
    res.status(error.statusCode || 500).json({ error: error.message });
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

function criarCodigoRecuperacao() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function criarTransporteEmail() {
  const gmailUser = String(process.env.GMAIL_USER || '').trim();
  const gmailPassword = String(process.env.GMAIL_APP_PASSWORD || '').trim();
  const smtpHost = String(process.env.SMTP_HOST || '').trim();
  const smtpUser = String(process.env.SMTP_USER || '').trim();
  const smtpPass = String(process.env.SMTP_PASS || '').trim();

  if (gmailUser && gmailPassword) {
    return {
      from: String(process.env.GMAIL_FROM || gmailUser).trim(),
      transport: nodemailer.createTransport({
        service: 'gmail',
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
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      }),
    };
  }

  return null;
}

async function enviarCodigoRecuperacaoPorEmail(destino, codigo) {
  const email = String(destino || '').trim();
  const config = criarTransporteEmail();

  if (!email) {
    throw new Error('Essa barbearia nao possui Gmail valido para recuperar a senha.');
  }

  if (!config) {
    const error = new Error(
      'Recuperacao por Gmail ainda nao esta configurada neste servidor. Adicione GMAIL_USER e GMAIL_APP_PASSWORD no Render.'
    );
    error.statusCode = 501;
    throw error;
  }

  await config.transport.sendMail({
    from: config.from,
    to: email,
    subject: 'Codigo de recuperacao do Barberflix',
    text: `Codigo de recuperacao do Barberflix: ${codigo}\n\nEsse codigo vale por 15 minutos. Se voce nao pediu essa troca, ignore esta mensagem.`,
    html: `<p>Codigo de recuperacao do Barberflix: <strong>${codigo}</strong></p><p>Esse codigo vale por 15 minutos. Se voce nao pediu essa troca, ignore esta mensagem.</p>`,
  });
}

function getMercadoPagoAccessToken() {
  return String(process.env.MP_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || '').trim();
}

function getPublicAppUrl(req) {
  return (
    String(process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim() ||
    `${req.protocol}://${req.get('host')}`
  ).replace(/\/$/, '');
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
      reason: `Assinatura mensal Barberflix - ${assinatura.barbearia_nome}`,
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
      a.lembrete_15_enviado_em
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

    res.json({
      suporteNumero,
      valorMensal: 1,
      whatsappBridgeUrl: process.env.WHATSAPP_BRIDGE_URL_PUBLIC || 'http://127.0.0.1:3010',
      gateway: {
        provider: 'mercado_pago',
        enabled: Boolean(getMercadoPagoAccessToken()),
        label: 'Mercado Pago',
      },
      pix: {
        chave: '119.063.635.28',
        favorecido: 'Gabriel Messias Rios',
      },
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
  const chavePix = '11906363528';
  res.json({ chave: chavePix, tipo: 'cpf' });
});

router.post('/publico/pix/qrcode', async (req, res) => {
  const { valor, descricao } = req.body;
  const chavePix = '11906363528';
  const nomeRecebedor = 'Gabriel Messias Rios';
  const cidade = 'SAO PAULO';
  const txid = `BARBER${Date.now()}`;
  const valorFormatado = Number.isFinite(Number(valor)) ? Number(valor).toFixed(2) : '0.00';
  const payload = `00020126360014BR.GOV.BCB.PIX0111${chavePix}520400005303986540${valorFormatado}5802BR5915${nomeRecebedor}6009${cidade}62070503${txid}6304`;

  res.json({ payload, txid, valor, descricao });
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
      res.status(403).json({ error: acesso.mensagem });
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
  const identificador = normalizarIdentificador(req.body.identificador);
  const metodo = String(req.body.metodo || '').trim().toLowerCase();

  if (!identificador || metodo !== 'email') {
    res.status(400).json({ error: 'Informe seu Gmail cadastrado para recuperar a senha.' });
    return;
  }

  try {
    const assinatura = await getAsync(
      `SELECT *
       FROM assinaturas
       WHERE telefone = ?
          OR whatsapp_numero = ?
          OR email = ?
       ORDER BY id DESC
       LIMIT 1`,
      [identificador, identificador, identificador]
    );

    if (!assinatura) {
      res.status(404).json({ error: 'Nao encontrei uma barbearia com esse contato.' });
      return;
    }

    if (!assinatura.email) {
      res.status(400).json({ error: 'Essa barbearia nao possui Gmail cadastrado para recuperar a senha.' });
      return;
    }

    const codigo = criarCodigoRecuperacao();
    passwordRecoveryRequests.set(assinatura.id, {
      hash: gerarHashSenha(codigo, assinatura.senha_salt),
      expiresAt: Date.now() + 15 * 60 * 1000,
      metodo: 'email',
      identificador: assinatura.email,
    });

    await enviarCodigoRecuperacaoPorEmail(assinatura.email, codigo);

    res.json({
      ok: true,
      mensagem: 'Enviamos um codigo de recuperacao para o Gmail da barbearia.',
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post('/barbeiro/recuperar-senha/redefinir', async (req, res) => {
  const identificador = normalizarIdentificador(req.body.identificador);
  const codigo = String(req.body.codigo || '').trim();
  const novaSenha = String(req.body.novaSenha || '');

  if (!identificador || !codigo || !novaSenha) {
    res.status(400).json({ error: 'Informe contato, codigo e a nova senha.' });
    return;
  }

  if (novaSenha.length < 4) {
    res.status(400).json({ error: 'A nova senha precisa ter pelo menos 4 caracteres.' });
    return;
  }

  try {
    const assinatura = await getAsync(
      `SELECT *
       FROM assinaturas
       WHERE telefone = ?
          OR whatsapp_numero = ?
          OR email = ?
       ORDER BY id DESC
       LIMIT 1`,
      [identificador, identificador, identificador]
    );

    if (!assinatura) {
      res.status(404).json({ error: 'Nao encontrei uma barbearia com esse contato.' });
      return;
    }

    const recovery = passwordRecoveryRequests.get(assinatura.id);

    if (!recovery || recovery.expiresAt < Date.now()) {
      passwordRecoveryRequests.delete(assinatura.id);
      res.status(410).json({ error: 'Seu codigo expirou. Solicite uma nova recuperacao.' });
      return;
    }

    const hashCodigo = gerarHashSenha(codigo, assinatura.senha_salt);

    if (hashCodigo !== recovery.hash) {
      res.status(401).json({ error: 'Codigo invalido.' });
      return;
    }

    const credenciais = criarCredenciaisSenha(novaSenha);

    await runAsync(
      `UPDATE assinaturas
       SET senha_hash = ?,
           senha_salt = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [credenciais.hash, credenciais.salt, assinatura.id]
    );

    passwordRecoveryRequests.delete(assinatura.id);

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
    res.status(400).json({ error: 'Informe um Gmail valido para liberar a assinatura no Mercado Pago.' });
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
        const checkout = await criarCheckoutMercadoPagoParaAssinatura(assinaturaAtualizada, req);

        res.status(200).json({
          mensagem: 'Cadastro atualizado. Agora finalize seu pagamento no Mercado Pago para liberar o login.',
          checkoutUrl: checkout.init_point || checkout.sandbox_init_point || null,
          gatewayStatus: checkout.status || 'pending',
          assinatura: await montarRespostaAssinatura(assinaturaExistente.id),
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
    const whatsappSession = `assinatura-${Date.now()}`;
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
        1,
        'pendente',
        suporteNumero,
        proximoVencimento,
        whatsappNumero || telefone,
        'nao_configurado',
        whatsappSession,
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

    const assinaturaCriada = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [result.lastID]);
    const checkout = await criarCheckoutMercadoPagoParaAssinatura(assinaturaCriada, req);

    res.status(201).json({
      mensagem: 'Cadastro concluido. Agora finalize o pagamento no Mercado Pago para liberar seu login.',
      checkoutUrl: checkout.init_point || checkout.sandbox_init_point || null,
      gatewayStatus: checkout.status || 'pending',
      assinatura: await montarRespostaAssinatura(result.lastID),
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

    iniciarSessao(id).catch((error) => {
      console.error(`Erro ao iniciar sessao do WhatsApp da assinatura ${id}:`, error.message);
    });

    await runAsync(
      `UPDATE assinaturas
       SET whatsapp_status = 'iniciando',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [id]
    );

    res.json({ ok: true, status: 'iniciando' });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        serializarDiasFuncionamento(diasFuncionamento),
        horarioAbertura || assinatura.horario_abertura || '08:00',
        horarioAlmocoInicio || assinatura.horario_almoco_inicio || '12:00',
        horarioAlmocoFim || assinatura.horario_almoco_fim || '13:00',
        horarioFechamento || assinatura.horario_fechamento || '18:00',
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

    const sessao = statusSessao(id);

    if (sessao.status && sessao.status !== assinatura.whatsapp_status) {
      await runAsync(
        `UPDATE assinaturas
         SET whatsapp_status = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [sessao.status, id]
      );
    }

    res.json(sessao);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/admin/login', async (req, res) => {
  const { pin } = req.body;

  if (!pin) {
    res.status(400).json({ error: 'PIN admin obrigatorio.' });
    return;
  }

  try {
    const adminPin = await getConfiguracao('admin_pin');

    if (String(pin) !== String(adminPin)) {
      res.status(401).json({ error: 'PIN admin invalido.' });
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
      valorMensal: 1,
      gateway: {
        provider: 'mercado_pago',
        enabled: Boolean(getMercadoPagoAccessToken()),
        label: 'Mercado Pago',
      },
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

module.exports = router;
