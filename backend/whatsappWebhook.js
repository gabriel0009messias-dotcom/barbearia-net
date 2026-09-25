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

  return getAsync("SELECT * FROM assinaturas WHERE whatsapp_bridge_token = $1", [token]);
}

async function resolverAssinatura({ assinaturaId, bridgeToken } = {}) {
  const porToken = await buscarAssinaturaPorBridgeToken(bridgeToken);
  if (porToken) {
    return porToken;
  }

  return null;
}

async function listarServicos(assinaturaId) {
  return allAsync("SELECT id, nome, preco FROM servicos_assinatura WHERE assinatura_id = $1 ORDER BY id", [assinaturaId]);
}

async function obterSessao(assinaturaId, telefone) {
  return getAsync(
    `SELECT *
     FROM sessoes
     WHERE assinatura_id = $1
       AND telefone = $2`,
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
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
     WHERE assinatura_id = $1
       AND telefone = $2`,
    [assinaturaId, telefone]
  );
}

async function horarioDisponivel(assinaturaId, data, hora) {
  return (await require('./services/whatsapp/scheduling').createScheduling(db).times(assinaturaId, data)).includes(hora);
}

async function obterOuCriarCliente(nome, telefone) {
  await db.transaction(async connection => {
    await connection.runAsync("INSERT INTO clientes (nome, telefone) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM clientes WHERE telefone = $2)", [nome, telefone]);
  });
  await runAsync("UPDATE clientes SET nome = $1 WHERE telefone = $2", [nome, telefone]);
  return getAsync("SELECT * FROM clientes WHERE telefone = $1", [telefone]);
}

async function obterOuCriarServicoPadrao(nome, preco) {
  const existente = await getAsync(
    `SELECT id
     FROM servicos
     WHERE lower(nome) = lower($1)
       AND preco = $2
     ORDER BY id ASC
     LIMIT 1`,
    [nome, Number(preco)]
  );

  if (existente?.id) {
    return existente.id;
  }

  const result = await runAsync('INSERT INTO servicos (nome, preco) VALUES ($1, $2)', [nome, Number(preco)]);
  return result.lastID;
}

async function criarAgendamento(assinaturaId, telefone, sessao, horario) {
  const { transaction } = require('./services/whatsapp/sessionRepository');
  const { createScheduling } = require('./services/whatsapp/scheduling');
  return transaction(async connection => {
    const scheduling = createScheduling(connection);
    const service = (await scheduling.services(assinaturaId)).find(s => s.name === sessao.servico);
    const result = service && await scheduling.book(assinaturaId, telefone, { name: sessao.nome, service, date: sessao.data, time: horario });
    if (!result) throw new Error('Horario ou servico indisponivel.');
    return { id: result.lastID, nome_cliente: sessao.nome, servico: service.name, preco: service.price, data: sessao.data, horario, telefone };
  });
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

  const a = await db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [assinaturaId]);
  if (!a) throw new Error('Estabelecimento não encontrado.');
  const access = require('./services/access').avaliarAcessoAssinatura(a);
  if (!access.liberado) throw Object.assign(new Error(access.mensagem), { statusCode: 403 });
  const base = String(process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) return 'Entre em contato com o estabelecimento para obter seu link de agendamento.';
  await db.transaction(c => require('./services/studiofy').createStudio(c).ensure(assinaturaId));
  return `Olá! Seja bem-vindo(a) ao ${a.barbearia_nome}!\nAgende pelo site: ${base}/agendar/${a.public_slug || 'studio-'+assinaturaId}`;
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
