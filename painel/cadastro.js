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

  qrCodeImage.hidden = true;
}

function atualizarPixInfo() {
  const mostrarPix = metodoPagamentoInput.value === 'pix' && pixConfig;
  pixInfoCard.hidden = !mostrarPix;

  if (!mostrarPix) {
    return;
  }

  pixFavorecidoLabel.textContent = `Favorecido: ${pixConfig.favorecido}`;
  pixChaveLabel.textContent = `Chave Pix: ${pixConfig.chave}`;
}

async function consultarStatusWhatsapp() {
  if (!assinaturaAtualId || !authToken) {
    return;
  }

  try {
    const status = await buscarJson(`/api/publico/assinaturas/${assinaturaAtualId}/whatsapp/status`);
    atualizarStatusWhatsapp(status.status, status.qrCode);

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

async function carregarSessaoAtual() {
  if (!authToken) {
    return;
  }

  try {
    const assinatura = await buscarJson('/api/barbeiro/me');
    assinaturaAtualId = assinatura.id;
    generateQrButton.disabled = false;
    whatsappHelpText.textContent = 'Seu cadastro ja esta ativo. Gere o QR Code ou abra seu painel normalmente.';
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

    authToken = resposta.token;
    assinaturaAtualId = resposta.assinatura.id;
    localStorage.setItem(TOKEN_STORAGE_KEY, authToken);
    generateQrButton.disabled = false;
    abrirPainelButton.hidden = false;
    assinaturaFormMessage.textContent = 'Cadastro concluido. Agora gere o QR Code e conecte o WhatsApp da barbearia.';
    whatsappHelpText.textContent = 'Seu teste de 24 horas esta ativo. Gere o QR Code para iniciar os agendamentos.';
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
    await buscarJson(`/api/publico/assinaturas/${assinaturaAtualId}/whatsapp/iniciar`, {
      method: 'POST',
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
