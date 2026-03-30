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
const crypto = require('crypto');
const express = require('express');

const db = require('./database');
const { iniciarSessao, statusSessao, clienteSessao } = require('./whatsappManager');

const router = express.Router();
const DIAS_VENCIMENTO = [5, 19, 26];
const METODOS_PAGAMENTO = ['pix', 'boleto'];
const STATUS_ASSINATURA = ['teste', 'pendente', 'ativo', 'bloqueado'];
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BARBER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

function calcularProximoVencimento(diaVencimento) {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth();
  let vencimento = new Date(ano, mes, diaVencimento);

  if (hoje.getDate() > diaVencimento) {
    vencimento = new Date(ano, mes + 1, diaVencimento);
  }

  return vencimento.toISOString().slice(0, 10);
}

function calcularPeriodoTeste() {
  const inicio = new Date();
  const fim = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);

  return {
    inicio: inicio.toISOString(),
    fim: fim.toISOString(),
  };
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

  if (assinatura.status === 'teste') {
    const expiracao = assinatura.trial_expires_at ? new Date(assinatura.trial_expires_at).getTime() : 0;

    if (expiracao > Date.now()) {
      return {
        liberado: true,
        motivo: 'periodo_teste',
        mensagem: 'Periodo de teste em andamento.',
      };
    }

    return {
      liberado: false,
      motivo: 'teste_expirado',
      mensagem: 'Seu teste de 24 horas terminou. Agora aguarde a liberacao do pagamento.',
    };
  }

  if (assinatura.status === 'pendente') {
    return {
      liberado: false,
      motivo: 'pagamento_pendente',
      mensagem: 'Assinatura pendente. Regularize o pagamento para liberar o sistema.',
    };
  }

  return {
    liberado: false,
    motivo: 'bloqueado',
    mensagem: 'Sistema bloqueado. Entre em contato para regularizar sua assinatura.',
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
  const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [session.assinaturaId]);

  if (!assinatura) {
    barberSessions.delete(token);
    return null;
  }

  const acesso = avaliarAcessoAssinatura(assinatura);

  if (!acesso.liberado) {
    barberSessions.delete(token);

    if (acesso.motivo === 'teste_expirado' && assinatura.status === 'teste') {
      await runAsync(
        `UPDATE assinaturas
         SET status = 'bloqueado',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [assinatura.id]
      );
    }

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
         WHEN 'teste' THEN 2
         ELSE 3
       END,
       proximo_vencimento ASC,
       created_at DESC`
  );

  const detalhadas = await Promise.all(
    assinaturas.map(async (assinatura) => ({
      ...mapearAssinatura(assinatura),
      servicos: await listarServicosDaAssinatura(assinatura.id),
    }))
  );

  return detalhadas;
}

async function montarRespostaAssinatura(assinaturaId) {
  const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [assinaturaId]);

  return {
    ...mapearAssinatura(assinatura),
    servicos: await listarServicosDaAssinatura(assinaturaId),
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

function normalizarTelefoneWhatsapp(telefone = '') {
  const digitos = String(telefone).replace(/\D/g, '');

  if (!digitos) {
    return null;
  }

  const numeroBrasil = digitos.startsWith('55') ? digitos : `55${digitos}`;
  return `${numeroBrasil}@c.us`;
}

function criarCodigoRecuperacao() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function assinaturaPertenceAoBarbeiro(req, res) {
  if (Number(req.params.id) !== Number(req.assinatura.id)) {
    res.status(403).json({ error: 'Essa assinatura nao pertence a este login.' });
    return false;
  }

  return true;
}

router.get('/agendamentos', requireBarbeiro, (req, res) => {
  const query = `
    SELECT
      a.id,
      c.nome AS cliente,
      c.telefone,
      s.nome AS servico,
      s.preco,
      a.data,
      a.hora,
      a.status
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

router.delete('/agendamentos/:id', requireBarbeiro, (req, res) => {
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

router.get('/bloqueios', requireBarbeiro, (req, res) => {
  db.all('SELECT * FROM bloqueios ORDER BY data ASC, hora ASC', [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.json(rows);
  });
});

router.post('/bloqueios', requireBarbeiro, (req, res) => {
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
      valorMensal: 50,
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

router.post('/barbeiro/login', async (req, res) => {
  const { identificador, senha } = req.body;
    // --- PIX ---
    // Endpoint para retornar a chave PIX fixa
    router.get('/publico/pix/chave', (req, res) => {
      // Chave PIX fixa (CPF)
      const chavePix = '11906363528';
      res.json({ chave: chavePix, tipo: 'cpf' });
    });

    // Endpoint para gerar QR Code dinâmico PIX (exemplo)
    // Para produção, integre com API de terceiros (Gerencianet, Mercado Pago, etc)
    router.post('/publico/pix/qrcode', async (req, res) => {
      const { valor, descricao } = req.body;
      // Exemplo: gerar payload estático (não faz cobrança real)
      // Para produção, use API de cobrança instantânea do seu banco ou gateway
      const chavePix = '11906363528';
      const nomeRecebedor = 'Barbearia Exemplo';
      const cidade = 'SAO PAULO';
      const txid = 'BARBER' + Date.now();
      // Payload Pix Copia e Cola (simples, sem validação)
      const payload = `00020126360014BR.GOV.BCB.PIX0111${chavePix}520400005303986540${valor ? valor.toFixed(2) : '0.00'}5802BR5915${nomeRecebedor}6009${cidade}62070503${txid}6304`;
      // Para produção, gere o CRC16 do payload e adicione ao final
      // Aqui, retornamos o payload simples para testes
      res.json({ payload, txid, valor, descricao });
    });

  if (!identificador || !senha) {
    res.status(400).json({ error: 'Informe seu telefone ou e-mail e a senha.' });
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

    if (!assinatura || !verificarSenha(senha, assinatura)) {
      res.status(401).json({ error: 'Login invalido.' });
      return;
    }

    const acesso = avaliarAcessoAssinatura(assinatura);

    if (!acesso.liberado) {
      if (acesso.motivo === 'teste_expirado' && assinatura.status === 'teste') {
        await runAsync(
          `UPDATE assinaturas
           SET status = 'bloqueado',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [assinatura.id]
        );
      }

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

  if (!identificador || !['telefone', 'email'].includes(metodo)) {
    res.status(400).json({ error: 'Informe telefone ou e-mail e escolha um metodo valido.' });
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

    if (metodo === 'email') {
      res.status(501).json({
        error:
          'Recuperacao por Gmail ainda nao esta configurada neste servidor. Use o telefone via WhatsApp ou fale com o suporte.',
      });
      return;
    }

    const client = clienteSessao(assinatura.id);

    if (!client) {
      res.status(409).json({
        error:
          'O WhatsApp dessa barbearia nao esta conectado agora. Conecte o numero ou fale com o suporte para redefinir a senha.',
      });
      return;
    }

    const destino = normalizarTelefoneWhatsapp(assinatura.whatsapp_numero || assinatura.telefone);

    if (!destino) {
      res.status(400).json({ error: 'Essa barbearia nao possui telefone valido para recuperar a senha.' });
      return;
    }

    const codigo = criarCodigoRecuperacao();
    passwordRecoveryRequests.set(assinatura.id, {
      hash: gerarHashSenha(codigo, assinatura.senha_salt),
      expiresAt: Date.now() + 15 * 60 * 1000,
      metodo: 'telefone',
      identificador,
    });

    await client.sendText(
      destino,
      `Codigo de recuperacao do Barberflix: ${codigo}\n\nEsse codigo vale por 15 minutos. Se voce nao pediu essa troca, ignore esta mensagem.`
    );

    res.json({
      ok: true,
      mensagem: 'Enviamos um codigo de recuperacao para o telefone da barbearia no WhatsApp.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

        const token = criarSessaoBarbeiro(assinaturaExistente.id);

        res.status(200).json({
          token,
          expiresInDays: 7,
          assinatura: await montarRespostaAssinatura(assinaturaExistente.id),
        });
        return;
      }

      res.status(409).json({
        error:
          'Essa barbearia ja usou o cadastro inicial ou ja possui assinatura registrada. O teste de 24 horas acontece apenas uma vez.',
      });
      return;
    }

    const suporteNumero = await getConfiguracao('suporte_numero');
    const proximoVencimento = calcularProximoVencimento(dia);
    const whatsappSession = `assinatura-${Date.now()}`;
    const teste = calcularPeriodoTeste();
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
        50,
        'teste',
        suporteNumero,
        proximoVencimento,
        whatsappNumero || telefone,
        'nao_configurado',
        whatsappSession,
        1,
        teste.inicio,
        teste.fim,
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

    const token = criarSessaoBarbeiro(result.lastID);

    res.status(201).json({
      token,
      expiresInDays: 7,
      assinatura: await montarRespostaAssinatura(result.lastID),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/publico/assinaturas/:id/whatsapp/iniciar', requireBarbeiro, async (req, res) => {
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

    const acesso = avaliarAcessoAssinatura(assinatura);

    if (!acesso.liberado) {
      if (acesso.motivo === 'teste_expirado' && assinatura.status === 'teste') {
        await runAsync(
          `UPDATE assinaturas
           SET status = 'bloqueado',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [id]
        );
      }

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

router.get('/publico/assinaturas/:id/acesso', requireBarbeiro, async (req, res) => {
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

    const acesso = avaliarAcessoAssinatura(assinatura);

    if (acesso.motivo === 'teste_expirado' && assinatura.status === 'teste') {
      await runAsync(
        `UPDATE assinaturas
         SET status = 'bloqueado',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [id]
      );
    }

    const assinaturaAtualizada = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);

    res.json({
      liberado: acesso.liberado,
      motivo: acesso.motivo,
      mensagem: acesso.mensagem,
      assinatura: mapearAssinatura(assinaturaAtualizada),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/publico/assinaturas/:id', requireBarbeiro, async (req, res) => {
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

    res.json({
      ...mapearAssinatura(assinatura),
      servicos: await listarServicosDaAssinatura(id),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/publico/assinaturas/:id', requireBarbeiro, async (req, res) => {
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

    const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);

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

    const atualizada = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);

    res.json({
      ...mapearAssinatura(atualizada),
      servicos: await listarServicosDaAssinatura(id),
    });
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

    const assinatura = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);

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
      valorMensal: 50,
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

    const proximoVencimento =
      status === 'ativo'
        ? calcularProximoVencimento(assinatura.dia_vencimento)
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

    const atualizada = await getAsync('SELECT * FROM assinaturas WHERE id = ?', [id]);

    res.json({
      ...atualizada,
      servicos: await listarServicosDaAssinatura(id),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
