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
const gatewayInfoCard = document.getElementById('gatewayInfoCard');
const gatewayMethodLabel = document.getElementById('gatewayMethodLabel');
const gatewayHelpLabel = document.getElementById('gatewayHelpLabel');
const gatewayCheckoutButton = document.getElementById('gatewayCheckoutButton');
const pixQrCard = document.getElementById('pixQrCard');
const pixQrImage = document.getElementById('pixQrImage');
const pixCopiaColaLabel = document.getElementById('pixCopiaColaLabel');
const cartaoDadosCard = document.getElementById('cartaoDadosCard');
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

let authToken = localStorage.getItem(TOKEN_STORAGE_KEY) || null;
let assinaturaAtualId = null;
let valorMensalAtual = 1;
let whatsappBridgeUrl = null;
let gatewayConfig = null;
let gatewayCheckoutUrl = null;
let pixQrCodeAtual = null;
const WHATSAPP_BRIDGE_FALLBACKS = ['http://localhost:3010', 'http://127.0.0.1:3010'];

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

function apenasDigitos(valor = '') {
  return String(valor).replace(/\D/g, '');
}

function atualizarObrigatoriedadeCartao(usandoCartao) {
  const camposCartao = cartaoDadosCard.querySelectorAll('input');

  camposCartao.forEach((campo) => {
    if (usandoCartao) {
      if (campo.id !== 'cartaoComplementoInput') {
        campo.setAttribute('required', 'required');
      }
      return;
    }

    campo.removeAttribute('required');
  });
}

function formatarMetodoPagamento(metodo) {
  if (metodo === 'cartao') {
    return 'Cartao de credito';
  }

  if (metodo === 'pix') {
    return 'Pix';
  }

  return metodo || '-';
}

function atualizarGatewayInfo() {
  const metodo = metodoPagamentoInput.value;
  const mostrar = Boolean(gatewayConfig?.enabled && metodo);
  const usandoCartao = metodo === 'cartao';
  const usandoPix = metodo === 'pix';
  gatewayInfoCard.hidden = !mostrar;
  cartaoDadosCard.hidden = !usandoCartao;
  atualizarObrigatoriedadeCartao(usandoCartao);
  pixQrCard.hidden = !usandoPix || !pixQrCodeAtual;

  if (!mostrar) {
    gatewayCheckoutButton.hidden = true;
    gatewayCheckoutUrl = null;
    pixQrCodeAtual = null;
    return;
  }

  gatewayMethodLabel.textContent = `Metodo selecionado: ${formatarMetodoPagamento(metodo)}`;
  gatewayHelpLabel.textContent =
    metodo === 'cartao'
      ? 'Voce sera levado ao Asaas para concluir a assinatura no cartao de credito.'
      : 'Escaneie o QR Code Pix abaixo para receber o pagamento na sua conta Asaas.';

  gatewayCheckoutButton.hidden = !gatewayCheckoutUrl;

  if (usandoPix && pixQrCodeAtual) {
    pixQrImage.hidden = !pixQrCodeAtual.imageUrl;
    pixQrImage.src = pixQrCodeAtual.imageUrl || '';
    pixCopiaColaLabel.textContent = pixQrCodeAtual.payload
      ? `Pix copia e cola: ${pixQrCodeAtual.payload}`
      : 'QR Code Pix gerado com sucesso.';
    return;
  }

  pixQrImage.hidden = true;
  pixQrImage.src = '';
  pixCopiaColaLabel.textContent = '';
}

async function carregarSessaoAtual() {
  if (!authToken) {
    return;
  }

  try {
    const assinatura = await buscarJson('/api/barbeiro/me');
    assinaturaAtualId = assinatura.id;
  } catch (error) {
    console.error(error);
  }
}

async function carregarConfiguracao() {
  try {
    const config = await buscarJson('/api/publico/assinatura-config');
    supportNumberLabel.textContent = `Suporte: ${config.suporteNumero || '--'}`;
    valorMensalAtual = Number(config.valorMensal || 1);
    whatsappBridgeUrl = config.whatsappBridgeUrl || 'http://127.0.0.1:3010';
    gatewayConfig = config.gateway || null;
    metodoPagamentoInput.innerHTML = config.metodosPagamento
      .map((metodo) => `<option value="${metodo}">${formatarMetodoPagamento(metodo)}</option>`)
      .join('');
    diaVencimentoInput.innerHTML = config.diasVencimento
      .map((dia) => `<option value="${dia}">Dia ${dia}</option>`)
      .join('');
    renderizarDiasFuncionamento(diasFuncionamentoInput, config.funcionamentoPadrao?.diasFuncionamento || [1, 2, 3, 4, 5, 6]);
    horarioAberturaInput.value = config.funcionamentoPadrao?.horarioAbertura || '08:00';
    horarioAlmocoInicioInput.value = config.funcionamentoPadrao?.horarioAlmocoInicio || '12:00';
    horarioAlmocoFimInput.value = config.funcionamentoPadrao?.horarioAlmocoFim || '13:00';
    horarioFechamentoInput.value = config.funcionamentoPadrao?.horarioFechamento || '18:00';
    atualizarGatewayInfo();
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
metodoPagamentoInput.addEventListener('change', atualizarGatewayInfo);
gatewayCheckoutButton.addEventListener('click', () => {
  if (gatewayCheckoutUrl) {
    window.location.href = gatewayCheckoutUrl;
  }
});

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
        cpfTitular: apenasDigitos(document.getElementById('cpfTitularInput').value),
        senha: document.getElementById('senhaAssinaturaInput').value,
        metodoPagamento: metodoPagamentoInput.value,
        diaVencimento: diaVencimentoInput.value,
        whatsappNumero: document.getElementById('whatsappNumeroInput').value,
        creditCard:
          metodoPagamentoInput.value === 'cartao'
            ? {
                holderName: document.getElementById('cartaoNomeTitularInput').value,
                number: apenasDigitos(document.getElementById('cartaoNumeroInput').value),
                expiryMonth: apenasDigitos(document.getElementById('cartaoMesExpiracaoInput').value),
                expiryYear: apenasDigitos(document.getElementById('cartaoAnoExpiracaoInput').value),
                ccv: apenasDigitos(document.getElementById('cartaoCvvInput').value),
              }
            : null,
        creditCardHolderInfo:
          metodoPagamentoInput.value === 'cartao'
            ? {
                name: document.getElementById('responsavelNomeInput').value,
                email: document.getElementById('emailAssinaturaInput').value,
                cpfCnpj: apenasDigitos(document.getElementById('cpfTitularInput').value),
                postalCode: apenasDigitos(document.getElementById('cartaoCepInput').value),
                addressNumber: document.getElementById('cartaoNumeroEnderecoInput').value,
                addressComplement: document.getElementById('cartaoComplementoInput').value,
                phone: apenasDigitos(document.getElementById('telefoneAssinaturaInput').value),
                mobilePhone: apenasDigitos(document.getElementById('telefoneAssinaturaInput').value),
              }
            : null,
        diasFuncionamento: coletarDiasSelecionados(diasFuncionamentoInput),
        horarioAbertura: horarioAberturaInput.value,
        horarioAlmocoInicio: horarioAlmocoInicioInput.value,
        horarioAlmocoFim: horarioAlmocoFimInput.value,
        horarioFechamento: horarioFechamentoInput.value,
        servicos: coletarServicos(),
      }),
    });

    assinaturaAtualId = resposta.assinatura.id;
    gatewayCheckoutUrl = resposta.checkoutUrl || null;
    pixQrCodeAtual = resposta.pixQrCode || null;
    authToken = null;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    assinaturaFormMessage.textContent =
      resposta.mensagem || 'Cadastro concluido. Agora finalize o pagamento para liberar seu login.';
    atualizarGatewayInfo();

    if (gatewayCheckoutUrl) {
      gatewayCheckoutButton.hidden = false;
    }
  } catch (error) {
    console.error(error);
    assinaturaFormMessage.textContent = error.message;
  }
});

criarLinhaServico('Corte degrade', '30');
criarLinhaServico('Luzes', '80');
carregarConfiguracao();
carregarSessaoAtual();
