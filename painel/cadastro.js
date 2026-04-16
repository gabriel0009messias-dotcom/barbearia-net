const TOKEN_STORAGE_KEY = 'barbearia_auth_token';
const PENDING_SIGNUP_STORAGE_KEY = 'barbearia_pending_signup';

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
const assinaturaForm = document.getElementById('assinaturaForm');
const assinaturaFormMessage = document.getElementById('assinaturaFormMessage');

let authToken = localStorage.getItem(TOKEN_STORAGE_KEY) || null;
let assinaturaAtualId = null;
let valorMensalAtual = 1;
let gatewayConfig = null;
let gatewayCheckoutUrl = null;
let pixQrCodeAtual = null;
let monitorLiberacao = null;

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

function escaparHtml(texto = '') {
  return String(texto)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function limparMonitorLiberacao() {
  if (monitorLiberacao) {
    clearInterval(monitorLiberacao);
    monitorLiberacao = null;
  }
}

function salvarCadastroPendente(payload) {
  localStorage.setItem(PENDING_SIGNUP_STORAGE_KEY, JSON.stringify(payload));
}

function limparCadastroPendente() {
  localStorage.removeItem(PENDING_SIGNUP_STORAGE_KEY);
}

function carregarCadastroPendente() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_SIGNUP_STORAGE_KEY) || 'null');
  } catch (error) {
    return null;
  }
}

async function fazerLoginAutomatico(email, senha) {
  const payload = await buscarJson('/api/barbeiro/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identificador: email,
      senha,
    }),
  });

  authToken = payload.token;
  limparCadastroPendente();
  localStorage.setItem(TOKEN_STORAGE_KEY, payload.token);
  window.location.href = '/barbeiro.html';
}

function iniciarMonitorLiberacao(assinaturaId, email, senha) {
  limparMonitorLiberacao();
  salvarCadastroPendente({ assinaturaId, email, senha });

  monitorLiberacao = setInterval(async () => {
    try {
      const status = await buscarJson(`/api/publico/assinaturas/${assinaturaId}/status`);

      if (status.liberado) {
        limparMonitorLiberacao();
        assinaturaFormMessage.textContent = 'Pagamento confirmado. Liberando seu painel...';
        await fazerLoginAutomatico(email, senha);
      }
    } catch (error) {
      console.error(error);
    }
  }, 5000);
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
    gatewayConfig = config.gateway || null;
    metodoPagamentoInput.innerHTML = config.metodosPagamento
      .map((metodo) => `<option value="${metodo}">${formatarMetodoPagamento(metodo)}</option>`)
      .join('');
    diaVencimentoInput.innerHTML = config.diasVencimento
      .map((dia) => `<option value="${dia}">Dia ${dia}</option>`)
      .join('');
    atualizarGatewayInfo();
  } catch (error) {
    console.error(error);
    assinaturaFormMessage.textContent = 'Nao consegui carregar a configuracao do cadastro.';
  }
}

metodoPagamentoInput.addEventListener('change', atualizarGatewayInfo);
gatewayCheckoutButton.addEventListener('click', () => {
  if (gatewayCheckoutUrl) {
    window.location.href = gatewayCheckoutUrl;
  }
});

assinaturaForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  limparMonitorLiberacao();

  try {
    const emailCadastro = document.getElementById('emailAssinaturaInput').value.trim();
    const senhaCadastro = document.getElementById('senhaAssinaturaInput').value;
    const resposta = await buscarJson('/api/publico/assinaturas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barbeariaNome: document.getElementById('barbeariaNomeInput').value,
        responsavelNome: document.getElementById('responsavelNomeInput').value,
        telefone: document.getElementById('telefoneAssinaturaInput').value,
        email: emailCadastro,
        cpfTitular: apenasDigitos(document.getElementById('cpfTitularInput').value),
        senha: senhaCadastro,
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
      }),
    });

    assinaturaAtualId = resposta.assinatura.id;
    gatewayCheckoutUrl = resposta.checkoutUrl || null;
    pixQrCodeAtual = resposta.pixQrCode || null;
    authToken = null;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    assinaturaFormMessage.textContent =
      resposta.mensagem || 'Cadastro concluido. Agora finalize o pagamento para liberar seu login.';
    iniciarMonitorLiberacao(resposta.assinatura.id, emailCadastro, senhaCadastro);

    if (gatewayCheckoutUrl) {
      gatewayCheckoutButton.hidden = false;
    }
  } catch (error) {
    console.error(error);
    assinaturaFormMessage.textContent = error.message;
  }
});

carregarConfiguracao();
carregarSessaoAtual();

const cadastroPendente = carregarCadastroPendente();
if (cadastroPendente?.assinaturaId && cadastroPendente?.email && cadastroPendente?.senha) {
  assinaturaFormMessage.textContent = 'Aguardando confirmacao do pagamento para liberar seu painel automaticamente...';
  iniciarMonitorLiberacao(cadastroPendente.assinaturaId, cadastroPendente.email, cadastroPendente.senha);
}
