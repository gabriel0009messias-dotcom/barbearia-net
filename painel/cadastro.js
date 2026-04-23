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
let monitorLiberacao = null;
let pixAtual = null;

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
    erro.details = payload;
    throw erro;
  }

  return payload;
}

function apenasDigitos(valor = '') {
  return String(valor).replace(/\D/g, '');
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

function renderizarPix(pix) {
  pixAtual = pix || null;
  gatewayInfoCard.hidden = !pixAtual;
  gatewayCheckoutButton.hidden = true;
  cartaoDadosCard.hidden = true;

  if (!pixAtual) {
    pixQrCard.hidden = true;
    pixQrImage.hidden = true;
    pixQrImage.removeAttribute('src');
    pixCopiaColaLabel.textContent = '';
    return;
  }

  gatewayMethodLabel.textContent = 'Metodo selecionado: Pix';
  gatewayHelpLabel.textContent = 'Pagamento manual. Depois de pagar, envie o comprovante no WhatsApp e aguarde a confirmacao do admin.';
  pixQrCard.hidden = false;
  pixQrImage.hidden = !pixAtual.qrCodeImageUrl;
  pixQrImage.src = pixAtual.qrCodeImageUrl || '';
  pixCopiaColaLabel.textContent = pixAtual.copiaCola
    ? `Pix copia e cola: ${pixAtual.copiaCola}`
    : 'Codigo Pix indisponivel.';
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

async function carregarConfiguracao() {
  try {
    const config = await buscarJson('/api/publico/assinatura-config');
    supportNumberLabel.textContent = `Suporte: ${config.suporteNumero || '--'}`;
    metodoPagamentoInput.innerHTML = '<option value="pix">Pix</option>';
    diaVencimentoInput.innerHTML = (config.diasVencimento || [])
      .map((dia) => `<option value="${dia}">Dia ${dia}</option>`)
      .join('');
    renderizarPix(config.pix || null);
  } catch (error) {
    console.error(error);
    assinaturaFormMessage.textContent = 'Nao consegui carregar a configuracao do cadastro.';
  }
}

metodoPagamentoInput?.addEventListener('change', () => {
  metodoPagamentoInput.value = 'pix';
  renderizarPix(pixAtual);
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
        barbeariaNome: document.getElementById('barbeariaNomeInput').value.trim(),
        responsavelNome: document.getElementById('responsavelNomeInput').value.trim(),
        telefone: document.getElementById('telefoneAssinaturaInput').value.trim(),
        email: emailCadastro,
        cpfTitular: apenasDigitos(document.getElementById('cpfTitularInput').value),
        senha: senhaCadastro,
        metodoPagamento: 'pix',
        diaVencimento: diaVencimentoInput.value,
        whatsappNumero: document.getElementById('whatsappNumeroInput').value.trim(),
        servicos: [{ nome: 'Corte', preco: 30 }],
      }),
    });

    authToken = null;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    renderizarPix(resposta.pix || resposta.assinatura?.pix || pixAtual);
    assinaturaFormMessage.textContent =
      resposta.mensagem ||
      'Cadastro concluido. Agora pague via Pix, envie o comprovante no WhatsApp e aguarde a confirmacao manual.';
    iniciarMonitorLiberacao(resposta.assinatura.id, emailCadastro, senhaCadastro);
  } catch (error) {
    console.error(error);
    assinaturaFormMessage.textContent = error.message;
  }
});

carregarConfiguracao();

const cadastroPendente = carregarCadastroPendente();
if (cadastroPendente?.assinaturaId && cadastroPendente?.email && cadastroPendente?.senha) {
  assinaturaFormMessage.textContent = 'Aguardando confirmacao manual do pagamento para liberar seu painel...';
  iniciarMonitorLiberacao(cadastroPendente.assinaturaId, cadastroPendente.email, cadastroPendente.senha);
}
