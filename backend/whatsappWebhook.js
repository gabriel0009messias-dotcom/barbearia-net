const db = require('./database');
const { clienteSessao } = require('./whatsappManager');

const { runAsync, getAsync, allAsync } = db;

function apenasDigitos(valor = '') {
  return String(valor || '').replace(/\D/g, '');
}

function normalizarTelefone(telefone = '') {
  const digitos = apenasDigitos(telefone);

  if (!digitos) {
    return '';
  }

  return digitos.startsWith('55') ? digitos : `55${digitos}`;
}

function normalizarMensagem(mensagem = '') {
  return String(mensagem || '').trim();
}

function formatarPreco(preco = 0) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number(preco || 0));
}

function formatarTelefoneParaEnvio(telefone = '') {
  const normalizado = normalizarTelefone(telefone);
  return normalizado ? `${normalizado}@c.us` : null;
}

function normalizarTexto(texto = '') {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function parseDataEntrada(texto = '') {
  const valor = String(texto || '').trim();

  if (/^\d{2}\/\d{2}$/.test(valor)) {
    const [dia, mes] = valor.split('/').map((item) => Number.parseInt(item, 10));
    const hoje = new Date();
    let ano = hoje.getFullYear();
    const candidata = new Date(ano, mes - 1, dia);

    if (
      candidata.getFullYear() !== ano ||
      candidata.getMonth() !== mes - 1 ||
      candidata.getDate() !== dia
    ) {
      return null;
    }

    const hojeSemHora = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    if (candidata < hojeSemHora) {
      candidata.setFullYear(ano + 1);
    }

    return candidata.toISOString().slice(0, 10);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    const data = new Date(`${valor}T00:00:00`);
    return Number.isNaN(data.getTime()) ? null : valor;
  }

  return null;
}

function horarioValido(texto = '') {
  return /^\d{2}:\d{2}$/.test(String(texto || '').trim());
}

async function buscarAssinaturaPorBridgeToken(token) {
  if (!token) {
    return null;
  }

  return getAsync('SELECT * FROM assinaturas WHERE whatsapp_bridge_token = ?', [token]);
}

async function resolverAssinatura({ assinaturaId, bridgeToken } = {}) {
  const idNumerico = Number.parseInt(assinaturaId, 10);

  if (Number.isInteger(idNumerico) && idNumerico > 0) {
    return getAsync('SELECT * FROM assinaturas WHERE id = ?', [idNumerico]);
  }

  const porToken = await buscarAssinaturaPorBridgeToken(bridgeToken);
  if (porToken) {
    return porToken;
  }

  const assinaturas = await allAsync('SELECT * FROM assinaturas ORDER BY id ASC LIMIT 2');
  return assinaturas.length === 1 ? assinaturas[0] : null;
}

async function listarServicos(assinaturaId) {
  const servicosAssinatura = await allAsync(
    `SELECT id, nome, preco
     FROM servicos_assinatura
     WHERE assinatura_id = ?
     ORDER BY id ASC`,
    [assinaturaId]
  );

  if (servicosAssinatura.length) {
    return servicosAssinatura;
  }

  return allAsync('SELECT id, nome, preco FROM servicos ORDER BY id ASC');
}

async function obterSessao(assinaturaId, telefone) {
  return getAsync(
    `SELECT *
     FROM sessoes
     WHERE assinatura_id = ?
       AND telefone = ?`,
    [assinaturaId, telefone]
  );
}

async function salvarSessao(assinaturaId, telefone, valores = {}) {
  const atual = await obterSessao(assinaturaId, telefone);
  const payload = {
    etapa: valores.etapa || atual?.etapa || 'aguardando_servico',
    servico: Object.prototype.hasOwnProperty.call(valores, 'servico') ? valores.servico : atual?.servico || null,
    preco: Object.prototype.hasOwnProperty.call(valores, 'preco') ? valores.preco : atual?.preco || null,
    nome: Object.prototype.hasOwnProperty.call(valores, 'nome') ? valores.nome : atual?.nome || null,
    data: Object.prototype.hasOwnProperty.call(valores, 'data') ? valores.data : atual?.data || null,
  };

  await runAsync(
    `INSERT INTO sessoes (assinatura_id, telefone, etapa, servico, preco, nome, data, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(assinatura_id, telefone) DO UPDATE SET
       etapa = excluded.etapa,
       servico = excluded.servico,
       preco = excluded.preco,
       nome = excluded.nome,
       data = excluded.data,
       updated_at = CURRENT_TIMESTAMP`,
    [assinaturaId, telefone, payload.etapa, payload.servico, payload.preco, payload.nome, payload.data]
  );
}

async function apagarSessao(assinaturaId, telefone) {
  await runAsync(
    `DELETE FROM sessoes
     WHERE assinatura_id = ?
       AND telefone = ?`,
    [assinaturaId, telefone]
  );
}

async function horarioDisponivel(assinaturaId, data, hora) {
  const agendamento = await getAsync(
    `SELECT id
     FROM agendamentos
     WHERE assinatura_id = ?
       AND data = ?
       AND hora = ?
       AND status = 'confirmado'
     LIMIT 1`,
    [assinaturaId, data, hora]
  );

  if (agendamento) {
    return false;
  }

  const bloqueio = await getAsync(
    `SELECT id
     FROM bloqueios
     WHERE assinatura_id = ?
       AND data = ?
       AND hora = ?
     LIMIT 1`,
    [assinaturaId, data, hora]
  );

  return !bloqueio;
}

async function obterOuCriarCliente(nome, telefone) {
  await runAsync('INSERT OR IGNORE INTO clientes (nome, telefone) VALUES (?, ?)', [nome, telefone]);
  await runAsync('UPDATE clientes SET nome = ? WHERE telefone = ?', [nome, telefone]);
  return getAsync('SELECT * FROM clientes WHERE telefone = ?', [telefone]);
}

async function obterOuCriarServicoPadrao(nome, preco) {
  const existente = await getAsync(
    `SELECT id
     FROM servicos
     WHERE lower(nome) = lower(?)
       AND preco = ?
     ORDER BY id ASC
     LIMIT 1`,
    [nome, Number(preco)]
  );

  if (existente?.id) {
    return existente.id;
  }

  const proximo = await getAsync('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM servicos');
  const novoId = Number(proximo?.id || 1);
  await runAsync('INSERT INTO servicos (id, nome, preco) VALUES (?, ?, ?)', [novoId, nome, Number(preco)]);
  return novoId;
}

async function criarAgendamento(assinaturaId, telefone, sessao, horario) {
  const nomeCliente = String(sessao.nome || '').trim();
  const servicoNome = String(sessao.servico || '').trim();
  const preco = Number(sessao.preco || 0);
  const cliente = await obterOuCriarCliente(nomeCliente, telefone);
  const servicoId = await obterOuCriarServicoPadrao(servicoNome, preco);

  const resultado = await runAsync(
    `INSERT INTO agendamentos (
       assinatura_id,
       cliente_id,
       servico_id,
       nome_cliente,
       telefone,
       servico_nome,
       preco,
       data,
       hora,
       status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [assinaturaId, cliente?.id || null, servicoId, nomeCliente, telefone, servicoNome, preco, sessao.data, horario, 'confirmado']
  );

  return {
    id: resultado.lastID,
    nome_cliente: nomeCliente,
    servico: servicoNome,
    preco,
    data: sessao.data,
    horario,
    telefone,
  };
}

async function sendMessage(assinaturaId, telefone, texto) {
  const client = clienteSessao(assinaturaId);
  const chatId = formatarTelefoneParaEnvio(telefone);

  if (client && chatId) {
    await client.sendText(chatId, texto);
    return { delivered: true, provider: 'wppconnect_local' };
  }

  return { delivered: false, provider: null };
}

async function processarMensagemWhatsapp({
  assinaturaId,
  telefone,
  mensagem,
}) {
  const telefoneNormalizado = normalizarTelefone(telefone);
  const texto = normalizarMensagem(mensagem);

  if (!telefoneNormalizado) {
    throw new Error('Telefone invalido.');
  }

  if (!texto) {
    throw new Error('Mensagem invalida.');
  }

  const sessao = await obterSessao(assinaturaId, telefoneNormalizado);
  const comando = normalizarTexto(texto);

  if (['oi', 'ola', 'olá', 'menu', 'iniciar'].includes(comando)) {
    const servicos = await listarServicos(assinaturaId);

    if (!servicos.length) {
      return 'Nenhum servico esta cadastrado no momento. Tente novamente mais tarde.';
    }

    await salvarSessao(assinaturaId, telefoneNormalizado, {
      etapa: 'aguardando_servico',
      servico: null,
      preco: null,
      nome: null,
      data: null,
    });

    return ['Escolha um servico:', '', ...servicos.map((item, index) => `${index + 1} - ${item.nome} (${formatarPreco(item.preco)})`)].join('\n');
  }

  if (!sessao) {
    return 'Digite "oi" ou "menu" para iniciar seu agendamento.';
  }

  if (sessao.etapa === 'aguardando_servico') {
    const servicos = await listarServicos(assinaturaId);
    const indice = Number.parseInt(texto, 10) - 1;
    const servico = servicos[indice];

    if (!servico) {
      return 'Servico invalido. Responda com o numero do servico desejado.';
    }

    await salvarSessao(assinaturaId, telefoneNormalizado, {
      etapa: 'aguardando_nome',
      servico: servico.nome,
      preco: Number(servico.preco || 0),
    });

    return 'Digite seu nome:';
  }

  if (sessao.etapa === 'aguardando_nome') {
    if (texto.length < 3 || /^\d+$/.test(texto)) {
      return 'Nome invalido. Digite seu nome completo.';
    }

    await salvarSessao(assinaturaId, telefoneNormalizado, {
      etapa: 'aguardando_data',
      nome: texto,
    });

    return 'Escolha o dia (ex: 10/05):';
  }

  if (sessao.etapa === 'aguardando_data') {
    const data = parseDataEntrada(texto);

    if (!data) {
      return 'Data invalida. Envie no formato 10/05.';
    }

    await salvarSessao(assinaturaId, telefoneNormalizado, {
      etapa: 'aguardando_horario',
      data,
    });

    return 'Escolha o horario (ex: 14:00):';
  }

  if (sessao.etapa === 'aguardando_horario') {
    if (!horarioValido(texto)) {
      return 'Horario invalido. Envie no formato 14:00.';
    }

    const disponivel = await horarioDisponivel(assinaturaId, sessao.data, texto);

    if (!disponivel) {
      return 'Esse horario ja esta ocupado. Escolha outro horario.';
    }

    const agendamento = await criarAgendamento(assinaturaId, telefoneNormalizado, sessao, texto);
    await apagarSessao(assinaturaId, telefoneNormalizado);

    return [
      'Agendamento confirmado!',
      `Nome: ${agendamento.nome_cliente}`,
      `Servico: ${agendamento.servico}`,
      `Valor: ${formatarPreco(agendamento.preco)}`,
      `Data: ${new Date(`${agendamento.data}T00:00:00`).toLocaleDateString('pt-BR')}`,
      `Horario: ${agendamento.horario}`,
    ].join('\n');
  }

  await apagarSessao(assinaturaId, telefoneNormalizado);
  return 'Digite "oi" ou "menu" para iniciar um novo agendamento.';
}

async function handleWhatsappWebhook({
  body = {},
  headers = {},
  assinatura = null,
} = {}) {
  const telefone = body.telefone || body.phone || body.from || '';
  const mensagem = body.mensagem || body.message || body.text || body.body || '';
  const assinaturaResolvida =
    assinatura ||
    (await resolverAssinatura({
      assinaturaId: body.assinaturaId || body.assinatura_id,
      bridgeToken: headers['x-whatsapp-bridge-token'],
    }));

  if (!assinaturaResolvida?.id) {
    throw new Error('Nao foi possivel identificar a assinatura para processar o webhook.');
  }

  const resposta = await processarMensagemWhatsapp({
    assinaturaId: assinaturaResolvida.id,
    telefone,
    mensagem,
  });

  const envio = await sendMessage(assinaturaResolvida.id, telefone, resposta);

  return {
    ok: true,
    assinaturaId: assinaturaResolvida.id,
    telefone: normalizarTelefone(telefone),
    resposta,
    delivered: envio.delivered,
    provider: envio.provider,
  };
}

module.exports = {
  handleWhatsappWebhook,
  processarMensagemWhatsapp,
  sendMessage,
};
