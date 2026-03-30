const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const DIAS_SEMANA = [
  { value: 0, label: 'Dom' },
  { value: 1, label: 'Seg' },
  { value: 2, label: 'Ter' },
  { value: 3, label: 'Qua' },
  { value: 4, label: 'Qui' },
  { value: 5, label: 'Sex' },
  { value: 6, label: 'Sab' },
];

const TOKEN_STORAGE_KEY = 'barbearia_auth_token';

const agendamentosTable = document.getElementById('agendamentosTable');
const agendamentoCount = document.getElementById('agendamentoCount');
const faturamentoDia = document.getElementById('faturamentoDia');
const faturamentoMes = document.getElementById('faturamentoMes');
const faturamentoAno = document.getElementById('faturamentoAno');
const bloqueiosList = document.getElementById('bloqueiosList');
const formMessage = document.getElementById('formMessage');
const refreshButton = document.getElementById('refreshButton');
const logoutBarbeiroButton = document.getElementById('logoutBarbeiroButton');
const bloqueioForm = document.getElementById('bloqueioForm');
const supportNumberLabel = document.getElementById('supportNumberLabel');
const generateQrButton = document.getElementById('generateQrButton');
const qrCodeImage = document.getElementById('qrCodeImage');
const qrStatusMessage = document.getElementById('qrStatusMessage');
const whatsappStatusBadge = document.getElementById('whatsappStatusBadge');
const whatsappHelpText = document.getElementById('whatsappHelpText');
const painelOperacional = document.getElementById('painelOperacional');
const painelLiberadoMessage = document.getElementById('painelLiberadoMessage');
const paymentReminderCard = document.getElementById('paymentReminderCard');
const paymentReminderText = document.getElementById('paymentReminderText');
const painelBloqueadoMessage = document.getElementById('painelBloqueadoMessage');
const blockedMessageText = document.getElementById('blockedMessageText');
const blockedPixCard = document.getElementById('blockedPixCard');
const blockedPixFavorecidoLabel = document.getElementById('blockedPixFavorecidoLabel');
const blockedPixQrPanel = document.getElementById('blockedPixQrPanel');
const blockedPixQrImage = document.getElementById('blockedPixQrImage');
const blockedPixChaveLabel = document.getElementById('blockedPixChaveLabel');
const configuracoesBarbeiroForm = document.getElementById('configuracoesBarbeiroForm');
const configuracoesMessage = document.getElementById('configuracoesMessage');
const diasFuncionamentoPainel = document.getElementById('diasFuncionamentoPainel');
const painelHorarioAberturaInput = document.getElementById('painelHorarioAberturaInput');
const painelHorarioAlmocoInicioInput = document.getElementById('painelHorarioAlmocoInicioInput');
const painelHorarioAlmocoFimInput = document.getElementById('painelHorarioAlmocoFimInput');
const painelHorarioFechamentoInput = document.getElementById('painelHorarioFechamentoInput');
const addPainelServiceButton = document.getElementById('addPainelServiceButton');
const painelServiceRows = document.getElementById('painelServiceRows');

let assinaturaAtualId = null;
let authToken = localStorage.getItem(TOKEN_STORAGE_KEY) || null;
let whatsappPolling = null;
let pixConfig = null;
let valorMensalAtual = 1;
let whatsappBridgeUrl = null;
const WHATSAPP_BRIDGE_FALLBACKS = ['http://localhost:3010', 'http://127.0.0.1:3010'];

function formatarData(data) {
  if (!data) return '-';
  return new Date(`${data}T00:00:00`).toLocaleDateString('pt-BR');
}

function escaparHtml(texto = '') {
  return String(texto)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getHeaders(extra = {}) {
  const headers = { ...extra };

  if (authToken) {
    headers['x-barbeiro-token'] = authToken;
  }

  return headers;
}

async function buscarJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: getHeaders(options.headers || {}),
  });

  if (!response.ok) {
    let detalhe = '';

    try {
      const payload = await response.json();
      detalhe = payload?.error ? payload.error : '';
    } catch (error) {
      detalhe = '';
    }

    const erro = new Error(detalhe || `Falha ao carregar ${url}`);
    erro.status = response.status;
    throw erro;
  }

  return response.json();
}

async function buscarBridgeToken() {
  const payload = await buscarJson(`/api/publico/assinaturas/${assinaturaAtualId}/whatsapp/bridge-token`, {
    method: 'POST',
  });

  return payload.token;
}

async function buscarJsonBridge(url, options = {}) {
  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      let detalhe = '';

      try {
        const payload = await response.json();
        detalhe = payload?.error ? payload.error : '';
      } catch (error) {
        detalhe = '';
      }

      const erro = new Error(detalhe || 'Nao consegui falar com o bot local do WhatsApp.');
      erro.status = response.status;
      throw erro;
    }

    return response.json();
  } catch (error) {
    if (error instanceof TypeError) {
      const erroRede = new Error(
        'Nao consegui falar com o bot local do WhatsApp. Abra o arquivo backend\\iniciar-whatsapp.bat e deixe a janela aberta.'
      );
      erroRede.status = 0;
      throw erroRede;
    }

    throw error;
  }
}

function getWhatsappBridgeBase() {
  return String(whatsappBridgeUrl || WHATSAPP_BRIDGE_FALLBACKS[0]).replace(/\/$/, '');
}

function listarBridgeBases() {
  const bases = [getWhatsappBridgeBase(), ...WHATSAPP_BRIDGE_FALLBACKS];
  return Array.from(new Set(bases.map((item) => String(item).replace(/\/$/, ''))));
}

async function buscarJsonBridgeComFallback(path, options = {}) {
  let ultimoErro = null;

  for (const base of listarBridgeBases()) {
    try {
      return await buscarJsonBridge(`${base}${path}`, options);
    } catch (error) {
      ultimoErro = error;
    }
  }

  throw ultimoErro || new Error('Nao consegui falar com o bot local do WhatsApp.');
}

function limparSessaoBarbeiro() {
  authToken = null;
  assinaturaAtualId = null;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function renderizarDiasFuncionamento(container, selecionados = [1, 2, 3, 4, 5, 6]) {
  container.innerHTML = DIAS_SEMANA.map(
    (dia) => `
      <label class="day-pill">
        <input type="checkbox" value="${dia.value}" ${selecionados.includes(dia.value) ? 'checked' : ''} />
        <span>${dia.label}</span>
      </label>
    `
  ).join('');
}

function coletarDiasSelecionados(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map((input) => Number(input.value));
}

function criarLinhaServico(container, nome = '', preco = '') {
  const row = document.createElement('div');
  row.className = 'service-row';
  row.innerHTML = `
    <input class="service-name-input" type="text" placeholder="Ex.: Corte degrade" value="${escaparHtml(nome)}" />
    <input class="service-price-input" type="number" min="1" step="0.01" placeholder="Preco" value="${escaparHtml(preco)}" />
    <button type="button" class="table-action danger-button" data-remove-service>Remover</button>
  `;

  container.appendChild(row);
}

function coletarServicos(container) {
  return Array.from(container.querySelectorAll('.service-row'))
    .map((row) => ({
      nome: row.querySelector('.service-name-input')?.value.trim(),
      preco: row.querySelector('.service-price-input')?.value,
    }))
    .filter((item) => item.nome && Number(item.preco) > 0);
}

function preencherConfiguracoesPainel(assinatura) {
  renderizarDiasFuncionamento(diasFuncionamentoPainel, assinatura.dias_funcionamento || [1, 2, 3, 4, 5, 6]);
  painelHorarioAberturaInput.value = assinatura.horario_abertura || '08:00';
  painelHorarioAlmocoInicioInput.value = assinatura.horario_almoco_inicio || '12:00';
  painelHorarioAlmocoFimInput.value = assinatura.horario_almoco_fim || '13:00';
  painelHorarioFechamentoInput.value = assinatura.horario_fechamento || '18:00';
  painelServiceRows.innerHTML = '';

  (assinatura.servicos || []).forEach((servico) => {
    criarLinhaServico(painelServiceRows, servico.nome, servico.preco);
  });

  if (!painelServiceRows.children.length) {
    criarLinhaServico(painelServiceRows, 'Corte degrade', '30');
  }
}

function renderizarAgendamentos(agendamentos) {
  agendamentoCount.textContent = `${agendamentos.length} itens`;

  if (!agendamentos.length) {
    agendamentosTable.innerHTML = '<tr><td colspan="6">Nenhum agendamento encontrado.</td></tr>';
    return;
  }

  agendamentosTable.innerHTML = agendamentos
    .map(
      (item) => `
        <tr>
          <td>${escaparHtml(item.cliente || item.telefone || 'Sem nome')}</td>
          <td>${escaparHtml(item.servico || '-')}</td>
          <td>${formatarData(item.data)}</td>
          <td>${escaparHtml(item.hora || '-')}</td>
          <td>${escaparHtml(item.status || '-')}</td>
          <td>
            <button class="table-action danger-button" data-id="${item.id}" type="button">Excluir</button>
          </td>
        </tr>
      `
    )
    .join('');
}

function renderizarFaturamento([dia, mes, ano]) {
  faturamentoDia.textContent = currency.format(Number(dia.total || 0));
  faturamentoMes.textContent = currency.format(Number(mes.total || 0));
  faturamentoAno.textContent = currency.format(Number(ano.total || 0));
}

function renderizarBloqueios(bloqueios) {
  if (!bloqueios.length) {
    bloqueiosList.innerHTML = '<li>Nenhum bloqueio cadastrado.</li>';
    return;
  }

  bloqueiosList.innerHTML = bloqueios
    .map((item) => `<li>${formatarData(item.data)} as ${escaparHtml(item.hora)}</li>`)
    .join('');
}

function atualizarStatusWhatsapp(status, qrCode) {
  const mapa = {
    nao_configurado: 'Aguardando cadastro',
    iniciando: 'Preparando QR',
    qr_pronto: 'QR pronto',
    conectado: 'Conectado',
    isLogged: 'Conectado',
    qrReadSuccess: 'Conectado',
    erro: 'Erro',
  };

  whatsappStatusBadge.textContent = mapa[status] || status || 'Aguardando cadastro';

  if (qrCode) {
    qrCodeImage.hidden = false;
    qrCodeImage.src = qrCode;
    qrStatusMessage.textContent = 'Escaneie este QR Code com o WhatsApp da barbearia.';
    return;
  }

  if (status === 'conectado' || status === 'isLogged' || status === 'qrReadSuccess') {
    qrCodeImage.hidden = true;
    qrStatusMessage.textContent = 'WhatsApp conectado com sucesso. Os agendamentos ja podem funcionar.';
    return;
  }

  if (status === 'erro') {
    qrCodeImage.hidden = true;
  }

  qrCodeImage.hidden = true;
}

async function atualizarPixBloqueado() {
  const mostrarPix = Boolean(pixConfig?.chave);
  blockedPixCard.hidden = !mostrarPix;

  if (!mostrarPix) {
    blockedPixQrPanel.hidden = true;
    blockedPixQrImage.hidden = true;
    blockedPixQrImage.removeAttribute('src');
    return;
  }

  blockedPixFavorecidoLabel.textContent = `Favorecido: ${pixConfig.favorecido}`;
  blockedPixChaveLabel.textContent = `Chave Pix: ${pixConfig.chave}`;

  try {
    const pagamentoPix = await buscarJson('/api/publico/pix/qrcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valor: valorMensalAtual,
        descricao: 'Assinatura mensal Barberflix',
      }),
    });

    blockedPixQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(
      pagamentoPix.payload
    )}`;
    blockedPixQrPanel.hidden = false;
    blockedPixQrImage.hidden = false;
  } catch (error) {
    console.error(error);
    blockedPixQrPanel.hidden = true;
    blockedPixQrImage.hidden = true;
  }
}

async function mostrarPainelBloqueado(mensagem) {
  painelOperacional.hidden = true;
  painelLiberadoMessage.hidden = true;
  paymentReminderCard.hidden = true;
  painelBloqueadoMessage.hidden = false;
  blockedMessageText.textContent = mensagem;
  generateQrButton.disabled = true;
  await atualizarPixBloqueado();
}

function atualizarLembretePagamento(assinatura) {
  const lembrete = assinatura?.lembrete_pagamento;

  if (!lembrete?.mensagem) {
    paymentReminderCard.hidden = true;
    return;
  }

  paymentReminderText.textContent = lembrete.mensagem;
  paymentReminderCard.hidden = false;
}

function tratarErroSessao(error) {
  if (error.status === 401) {
    limparSessaoBarbeiro();
    window.location.href = '/';
    return true;
  }

  if (error.status === 403) {
    void mostrarPainelBloqueado(error.message);
    return true;
  }

  return false;
}

async function carregarPainelBarbeiro() {
  if (!authToken) {
    window.location.href = '/';
    return;
  }

  try {
    const config = await buscarJson('/api/publico/assinatura-config');
    supportNumberLabel.textContent = `Suporte: ${config.suporteNumero || '--'}`;
    pixConfig = config.pix || null;
    valorMensalAtual = Number(config.valorMensal || 1);
    whatsappBridgeUrl = config.whatsappBridgeUrl || 'http://127.0.0.1:3010';

    const assinatura = await buscarJson('/api/barbeiro/me');
    assinaturaAtualId = assinatura.id;
    generateQrButton.disabled = false;
    whatsappHelpText.textContent =
      'Seu acesso esta liberado. Gere o QR Code e acompanhe seu numero de WhatsApp por aqui sempre que precisar.';

    const [agendamentos, dia, mes, ano, bloqueios] = await Promise.all([
      buscarJson('/api/agendamentos'),
      buscarJson('/api/faturamento?periodo=dia'),
      buscarJson('/api/faturamento?periodo=mes'),
      buscarJson('/api/faturamento?periodo=ano'),
      buscarJson('/api/bloqueios'),
    ]);

    painelOperacional.hidden = false;
    painelLiberadoMessage.hidden = false;
    atualizarLembretePagamento(assinatura);
    painelBloqueadoMessage.hidden = true;
    renderizarAgendamentos(agendamentos);
    renderizarFaturamento([dia, mes, ano]);
    renderizarBloqueios(bloqueios);
    preencherConfiguracoesPainel(assinatura);
    await consultarStatusWhatsapp();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    formMessage.textContent = 'Nao consegui carregar o painel do barbeiro.';
  }
}

async function excluirAgendamento(id) {
  await buscarJson(`/api/agendamentos/${id}`, { method: 'DELETE' });
}

async function consultarStatusWhatsapp() {
  if (!assinaturaAtualId || !authToken) {
    return;
  }

  try {
    const status = await buscarJsonBridgeComFallback(`/sessions/${assinaturaAtualId}/status`);
    atualizarStatusWhatsapp(status.status, status.qrCode);

    if (status.status === 'erro') {
      qrStatusMessage.textContent = status.ultimoErro || 'Nao consegui iniciar o bot local do WhatsApp.';
    }

    if (status.status === 'conectado' || status.status === 'isLogged' || status.status === 'qrReadSuccess') {
      clearInterval(whatsappPolling);
      whatsappPolling = null;
    }
  } catch (error) {
    console.error(error);
    qrStatusMessage.textContent = error.message;
  }
}

function iniciarPollingWhatsapp() {
  if (whatsappPolling) {
    clearInterval(whatsappPolling);
  }

  whatsappPolling = setInterval(consultarStatusWhatsapp, 5000);
}

bloqueioForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const data = document.getElementById('dataInput').value;
  const hora = document.getElementById('horaInput').value;

  try {
    await buscarJson('/api/bloqueios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, hora }),
    });

    formMessage.textContent = 'Horario bloqueado com sucesso.';
    bloqueioForm.reset();
    await carregarPainelBarbeiro();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    formMessage.textContent = 'Nao consegui salvar o bloqueio.';
  }
});

configuracoesBarbeiroForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!assinaturaAtualId) {
    configuracoesMessage.textContent = 'Entre no painel primeiro.';
    return;
  }

  try {
    await buscarJson(`/api/publico/assinaturas/${assinaturaAtualId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        diasFuncionamento: coletarDiasSelecionados(diasFuncionamentoPainel),
        horarioAbertura: painelHorarioAberturaInput.value,
        horarioAlmocoInicio: painelHorarioAlmocoInicioInput.value,
        horarioAlmocoFim: painelHorarioAlmocoFimInput.value,
        horarioFechamento: painelHorarioFechamentoInput.value,
        servicos: coletarServicos(painelServiceRows),
      }),
    });

    configuracoesMessage.textContent = 'Configuracoes atualizadas com sucesso.';
    await carregarPainelBarbeiro();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    configuracoesMessage.textContent = 'Nao consegui atualizar as configuracoes da barbearia.';
  }
});

function configurarRemocaoServico(container) {
  container.addEventListener('click', (event) => {
    const botao = event.target.closest('[data-remove-service]');

    if (!botao) {
      return;
    }

    const rows = container.querySelectorAll('.service-row');

    if (rows.length === 1) {
      return;
    }

    botao.closest('.service-row')?.remove();
  });
}

configurarRemocaoServico(painelServiceRows);
addPainelServiceButton.addEventListener('click', () => criarLinhaServico(painelServiceRows));

generateQrButton.addEventListener('click', async () => {
  if (!assinaturaAtualId) {
    qrStatusMessage.textContent = 'Entre no painel antes de gerar o QR Code.';
    return;
  }

  try {
    qrStatusMessage.textContent = 'Preparando o QR Code do WhatsApp...';
    const bridgeToken = await buscarBridgeToken();
    await buscarJsonBridgeComFallback(`/sessions/${assinaturaAtualId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiBaseUrl: window.location.origin,
        bridgeToken,
      }),
    });

    await consultarStatusWhatsapp();
    iniciarPollingWhatsapp();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    qrStatusMessage.textContent = error.message;
    whatsappStatusBadge.textContent = 'Erro local';
  }
});

agendamentosTable.addEventListener('click', async (event) => {
  const botao = event.target.closest('button[data-id]');

  if (!botao) {
    return;
  }

  const { id } = botao.dataset;
  const confirmou = window.confirm('Tem certeza que deseja excluir este agendamento?');

  if (!confirmou) {
    return;
  }

  try {
    botao.disabled = true;
    await excluirAgendamento(id);
    formMessage.textContent = 'Agendamento excluido com sucesso.';
    await carregarPainelBarbeiro();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    formMessage.textContent = 'Nao consegui excluir o agendamento.';
    botao.disabled = false;
  }
});

logoutBarbeiroButton.addEventListener('click', async () => {
  try {
    await buscarJson('/api/barbeiro/logout', { method: 'POST' });
  } catch (error) {
    console.error(error);
  } finally {
    limparSessaoBarbeiro();
    window.location.href = '/';
  }
});

refreshButton.addEventListener('click', carregarPainelBarbeiro);

renderizarDiasFuncionamento(diasFuncionamentoPainel, [1, 2, 3, 4, 5, 6]);
carregarPainelBarbeiro();
