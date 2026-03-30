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

const supportNumberLabel = document.getElementById('supportNumberLabel');
const metodoPagamentoInput = document.getElementById('metodoPagamentoInput');
const pixInfoCard = document.getElementById('pixInfoCard');
const pixFavorecidoLabel = document.getElementById('pixFavorecidoLabel');
const pixChaveLabel = document.getElementById('pixChaveLabel');
const pixQrPanel = document.getElementById('pixQrPanel');
const pixQrImage = document.getElementById('pixQrImage');
const diaVencimentoInput = document.getElementById('diaVencimentoInput');
const diasFuncionamentoInput = document.getElementById('diasFuncionamentoInput');
const horarioAberturaInput = document.getElementById('horarioAberturaInput');
const horarioAlmocoInicioInput = document.getElementById('horarioAlmocoInicioInput');
const horarioAlmocoFimInput = document.getElementById('horarioAlmocoFimInput');
const horarioFechamentoInput = document.getElementById('horarioFechamentoInput');
const addServiceButton = document.getElementById('addServiceButton');
const serviceRows = document.getElementById('serviceRows');
const assinaturaForm = document.getElementById('assinaturaForm');
const assinaturaFormMessage = document.getElementById('assinaturaFormMessage');
const generateQrButton = document.getElementById('generateQrButton');
const abrirPainelButton = document.getElementById('abrirPainelButton');
const qrCodeImage = document.getElementById('qrCodeImage');
const qrStatusMessage = document.getElementById('qrStatusMessage');
const whatsappStatusBadge = document.getElementById('whatsappStatusBadge');
const whatsappHelpText = document.getElementById('whatsappHelpText');

let authToken = localStorage.getItem(TOKEN_STORAGE_KEY) || null;
let assinaturaAtualId = null;
let whatsappPolling = null;
let pixConfig = null;
let valorMensalAtual = 1;
let whatsappBridgeUrl = null;

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

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const erro = new Error(payload?.error || `Falha ao carregar ${url}`);
    erro.status = response.status;
    throw erro;
  }

  return payload;
}

async function buscarJsonBridge(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const erro = new Error(payload?.error || 'Nao consegui falar com o bot local do WhatsApp.');
    erro.status = response.status;
    throw erro;
  }

  return payload;
}

function getWhatsappBridgeBase() {
  return String(whatsappBridgeUrl || 'http://127.0.0.1:3010').replace(/\/$/, '');
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

function escaparHtml(texto = '') {
  return String(texto)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function criarLinhaServico(nome = '', preco = '') {
  const row = document.createElement('div');
  row.className = 'service-row';
  row.innerHTML = `
    <input class="service-name-input" type="text" placeholder="Ex.: Corte degrade" value="${escaparHtml(nome)}" />
    <input class="service-price-input" type="number" min="1" step="0.01" placeholder="Preco" value="${escaparHtml(preco)}" />
    <button type="button" class="table-action danger-button" data-remove-service>Remover</button>
  `;
  serviceRows.appendChild(row);
}

function coletarServicos() {
  return Array.from(serviceRows.querySelectorAll('.service-row'))
    .map((row) => ({
      nome: row.querySelector('.service-name-input')?.value.trim(),
      preco: row.querySelector('.service-price-input')?.value,
    }))
    .filter((item) => item.nome && Number(item.preco) > 0);
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
    qrStatusMessage.textContent = 'WhatsApp conectado com sucesso.';
    abrirPainelButton.hidden = false;
    return;
  }

  if (status === 'erro') {
    qrCodeImage.hidden = true;
  }

  qrCodeImage.hidden = true;
}

async function atualizarPixInfo() {
  const mostrarPix = metodoPagamentoInput.value === 'pix' && pixConfig;
  pixInfoCard.hidden = !mostrarPix;

  if (!mostrarPix) {
    pixQrPanel.hidden = true;
    pixQrImage.hidden = true;
    pixQrImage.removeAttribute('src');
    return;
  }

  pixFavorecidoLabel.textContent = `Favorecido: ${pixConfig.favorecido}`;
  pixChaveLabel.textContent = `Chave Pix: ${pixConfig.chave}`;

  try {
    const pagamentoPix = await buscarJson('/api/publico/pix/qrcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valor: valorMensalAtual,
        descricao: 'Assinatura mensal Barberflix',
      }),
    });

    pixQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(
      pagamentoPix.payload
    )}`;
    pixQrPanel.hidden = false;
    pixQrImage.hidden = false;
  } catch (error) {
    console.error(error);
    pixQrPanel.hidden = true;
    pixQrImage.hidden = true;
  }
}

async function consultarStatusWhatsapp() {
  if (!assinaturaAtualId || !authToken) {
    return;
  }

  try {
    const status = await buscarJsonBridge(`${getWhatsappBridgeBase()}/sessions/${assinaturaAtualId}/status`);
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
    qrStatusMessage.textContent =
      'Nao consegui falar com o bot local do WhatsApp. Abra a pasta do projeto e rode backend\\iniciar-whatsapp.bat ou npm run bot dentro de backend.';
  }
}

function iniciarPollingWhatsapp() {
  if (whatsappPolling) {
    clearInterval(whatsappPolling);
  }

  whatsappPolling = setInterval(consultarStatusWhatsapp, 5000);
}

async function carregarSessaoAtual() {
  if (!authToken) {
    return;
  }

  try {
    const assinatura = await buscarJson('/api/barbeiro/me');
    assinaturaAtualId = assinatura.id;
    generateQrButton.disabled = false;
    whatsappHelpText.textContent = 'Seu acesso esta liberado. Gere o QR Code ou abra seu painel normalmente.';
    abrirPainelButton.hidden = false;
  } catch (error) {
    console.error(error);
  }
}

async function carregarConfiguracao() {
  try {
    const config = await buscarJson('/api/publico/assinatura-config');
    supportNumberLabel.textContent = `Suporte: ${config.suporteNumero || '--'}`;
    pixConfig = config.pix || null;
    valorMensalAtual = Number(config.valorMensal || 1);
    whatsappBridgeUrl = config.whatsappBridgeUrl || 'http://127.0.0.1:3010';
    metodoPagamentoInput.innerHTML = config.metodosPagamento
      .map((metodo) => `<option value="${metodo}">${metodo.toUpperCase()}</option>`)
      .join('');
    diaVencimentoInput.innerHTML = config.diasVencimento
      .map((dia) => `<option value="${dia}">Dia ${dia}</option>`)
      .join('');
    renderizarDiasFuncionamento(diasFuncionamentoInput, config.funcionamentoPadrao?.diasFuncionamento || [1, 2, 3, 4, 5, 6]);
    horarioAberturaInput.value = config.funcionamentoPadrao?.horarioAbertura || '08:00';
    horarioAlmocoInicioInput.value = config.funcionamentoPadrao?.horarioAlmocoInicio || '12:00';
    horarioAlmocoFimInput.value = config.funcionamentoPadrao?.horarioAlmocoFim || '13:00';
    horarioFechamentoInput.value = config.funcionamentoPadrao?.horarioFechamento || '18:00';
    atualizarPixInfo();
  } catch (error) {
    console.error(error);
    assinaturaFormMessage.textContent = 'Nao consegui carregar a configuracao do cadastro.';
  }
}

serviceRows.addEventListener('click', (event) => {
  const botao = event.target.closest('[data-remove-service]');

  if (!botao) {
    return;
  }

  const rows = serviceRows.querySelectorAll('.service-row');

  if (rows.length === 1) {
    return;
  }

  botao.closest('.service-row')?.remove();
});

addServiceButton.addEventListener('click', () => criarLinhaServico());
metodoPagamentoInput.addEventListener('change', atualizarPixInfo);

assinaturaForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const resposta = await buscarJson('/api/publico/assinaturas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barbeariaNome: document.getElementById('barbeariaNomeInput').value,
        responsavelNome: document.getElementById('responsavelNomeInput').value,
        telefone: document.getElementById('telefoneAssinaturaInput').value,
        email: document.getElementById('emailAssinaturaInput').value,
        senha: document.getElementById('senhaAssinaturaInput').value,
        metodoPagamento: metodoPagamentoInput.value,
        diaVencimento: diaVencimentoInput.value,
        whatsappNumero: document.getElementById('whatsappNumeroInput').value,
        diasFuncionamento: coletarDiasSelecionados(diasFuncionamentoInput),
        horarioAbertura: horarioAberturaInput.value,
        horarioAlmocoInicio: horarioAlmocoInicioInput.value,
        horarioAlmocoFim: horarioAlmocoFimInput.value,
        horarioFechamento: horarioFechamentoInput.value,
        servicos: coletarServicos(),
      }),
    });

    assinaturaAtualId = resposta.assinatura.id;
    authToken = null;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    generateQrButton.disabled = true;
    abrirPainelButton.hidden = true;
    assinaturaFormMessage.textContent =
      resposta.mensagem || 'Cadastro concluido. Agora faça o pagamento para liberar seu login.';
    whatsappHelpText.textContent =
      'Pagamento aguardando confirmacao. Assim que sua assinatura for liberada, o WhatsApp e o painel ficam disponiveis.';
    atualizarStatusWhatsapp(resposta.assinatura.whatsapp_status);
  } catch (error) {
    console.error(error);
    assinaturaFormMessage.textContent = error.message;
  }
});

generateQrButton.addEventListener('click', async () => {
  if (!assinaturaAtualId) {
    qrStatusMessage.textContent = 'Cadastre sua barbearia primeiro.';
    return;
  }

  try {
    qrStatusMessage.textContent = 'Preparando o QR Code do WhatsApp...';
    await buscarJsonBridge(`${getWhatsappBridgeBase()}/sessions/${assinaturaAtualId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiBaseUrl: window.location.origin,
        barberToken: authToken,
      }),
    });
    await consultarStatusWhatsapp();
    iniciarPollingWhatsapp();
  } catch (error) {
    console.error(error);
    qrStatusMessage.textContent = error.message;
  }
});

criarLinhaServico('Corte degrade', '30');
criarLinhaServico('Luzes', '80');
carregarConfiguracao();
carregarSessaoAtual();
