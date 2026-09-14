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
let checkoutUrl = null;

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

function renderizarCheckout(url = null) {
  checkoutUrl = url;
  gatewayInfoCard.hidden = false;
  gatewayCheckoutButton.hidden = !url;
  gatewayCheckoutButton.textContent = 'Pagar com Mercado Pago';
  gatewayMethodLabel.textContent = 'Plano Profissional - R$ 65,00 por 30 dias';
  gatewayHelpLabel.textContent = 'Pague no Mercado Pago. O acesso sera liberado apos a confirmacao do pagamento.';
  pixQrCard.hidden = true;
  cartaoDadosCard.hidden = true;
}

gatewayCheckoutButton.addEventListener('click', () => {
  if (checkoutUrl) window.location.assign(checkoutUrl);
});

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
  salvarCadastroPendente({ assinaturaId, email });

  monitorLiberacao = setInterval(async () => {
    try {
      const status = await buscarJson(`/api/publico/assinaturas/${assinaturaId}/status`);

      if (status.liberado) {
        limparMonitorLiberacao();
        assinaturaFormMessage.textContent = 'Pagamento confirmado. Liberando seu painel...';
        if (senha) await fazerLoginAutomatico(email, senha);
        else {
          limparCadastroPendente();
          assinaturaFormMessage.textContent = 'Pagamento confirmado! Entre com seu email e senha na pagina inicial.';
          gatewayCheckoutButton.hidden = true;
        }
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
    metodoPagamentoInput.innerHTML = '<option value="mercado_pago">Mercado Pago</option>';
    diaVencimentoInput.innerHTML = (config.diasVencimento || [])
      .map((dia) => `<option value="${dia}">Dia ${dia}</option>`)
      .join('');
    renderizarCheckout();
  } catch (error) {
    console.error(error);
    assinaturaFormMessage.textContent = 'Nao consegui carregar a configuracao do cadastro.';
  }
}

metodoPagamentoInput?.addEventListener('change', () => {
  metodoPagamentoInput.value = 'mercado_pago';
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
        metodoPagamento: 'mercado_pago',
        diaVencimento: diaVencimentoInput.value,
        whatsappNumero: document.getElementById('whatsappNumeroInput').value.trim(),
        servicos: [{ nome: 'Corte', preco: 30 }],
      }),
    });

    authToken = null;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    iniciarMonitorLiberacao(resposta.assinatura.id, emailCadastro, senhaCadastro);
    const checkout = await buscarJson(`/api/publico/assinaturas/${resposta.assinatura.id}/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: senhaCadastro }),
    });
    renderizarCheckout(checkout.checkoutUrl);
    assinaturaFormMessage.textContent =
      'Cadastro concluido. Clique em Pagar com Mercado Pago.';
  } catch (error) {
    console.error(error);
    assinaturaFormMessage.textContent = error.message;
  }
});

carregarConfiguracao();

const cadastroPendente = carregarCadastroPendente();
if (cadastroPendente?.assinaturaId) {
  assinaturaFormMessage.textContent = 'Aguardando confirmacao do Mercado Pago. Se ainda nao pagou, entre pela pagina inicial para continuar.';
  iniciarMonitorLiberacao(cadastroPendente.assinaturaId, cadastroPendente.email);
}
