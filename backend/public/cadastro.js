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
const diaVencimentoInput = document.getElementById('diaVencimentoInput');
const assinaturaForm = document.getElementById('assinaturaForm');
const assinaturaFormMessage = document.getElementById('assinaturaFormMessage');

const submitButton = assinaturaForm.querySelector('button[type="submit"]');
const cadastroConfigMessage = document.getElementById('cadastroConfigMessage');
const planPriceLabel = document.getElementById('planPriceLabel');
let authToken = lerStorage(TOKEN_STORAGE_KEY);
let enviando = false;
let monitorLiberacao = null;
let checkoutUrl = null;
let planoAtual = null;

function exibirPlano(plan) {
  if (!plan || !Number.isSafeInteger(plan.amountCents) || plan.amountCents <= 0 ||
      !Number.isSafeInteger(plan.durationDays) || plan.durationDays <= 0 || plan.currency !== 'BRL' || !plan.name) {
    throw new Error('O servidor nao informou um plano valido. Tente novamente.');
  }
  planoAtual = plan;
  const valor = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: plan.currency }).format(plan.amountCents / 100);
  const label = `${plan.name} - ${valor} por ${plan.durationDays} dias`;
  planPriceLabel.textContent = label;
  gatewayMethodLabel.textContent = label;
}

function lerStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function gravarStorage(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* O cadastro tambem funciona quando o navegador bloqueia o armazenamento. */ }
}

function mostrarMensagem(message, focus = false) {
  assinaturaFormMessage.textContent = message;
  if (focus) {
    assinaturaFormMessage.focus();
    assinaturaFormMessage.scrollIntoView({ block: 'center' });
  }
}

function getHeaders(extra = {}) {
  const headers = { ...extra };

  if (authToken) {
    headers['x-barbeiro-token'] = authToken;
  }

  return headers;
}

async function buscarJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
    ...options,
    headers: getHeaders(options.headers || {}),
      signal: controller.signal,
    });
    let payload;
    try { payload = await response.json(); } catch {
      throw new Error(`O servidor retornou uma resposta invalida (HTTP ${response.status}). Tente novamente.`);
    }
    if (!response.ok) {
      const message = typeof payload?.error === 'string' ? payload.error : 'Nao foi possivel concluir a solicitacao.';
      throw new Error(`${message} (HTTP ${response.status})`);
    }
    if (!payload || typeof payload !== 'object') throw new Error('Resposta invalida do servidor. Tente novamente.');
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('O servidor demorou para responder. Tente novamente em instantes.');
    if (error instanceof TypeError) throw new Error('Nao foi possivel conectar ao servidor. Verifique sua conexao e tente novamente.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
  gravarStorage(PENDING_SIGNUP_STORAGE_KEY, JSON.stringify(payload));
}

function limparCadastroPendente() {
  gravarStorage(PENDING_SIGNUP_STORAGE_KEY, null);
}

function carregarCadastroPendente() {
  try {
    return JSON.parse(lerStorage(PENDING_SIGNUP_STORAGE_KEY) || 'null');
  } catch (error) {
    return null;
  }
}

function renderizarCheckout(url = null) {
  checkoutUrl = url;
  gatewayInfoCard.hidden = false;
  gatewayCheckoutButton.hidden = !url;
  gatewayCheckoutButton.textContent = 'Pagar com Mercado Pago';
  if (planoAtual) exibirPlano(planoAtual);
  gatewayHelpLabel.textContent = 'Pague no Mercado Pago. O acesso sera liberado apos a confirmacao do pagamento.';
  pixQrCard.hidden = true;
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
  gravarStorage(TOKEN_STORAGE_KEY, payload.token);
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
      mostrarMensagem(`Nao foi possivel verificar a liberacao: ${error.message}`);
    }
  }, 5000);
}

async function carregarConfiguracao() {
  try {
    const config = await buscarJson('/api/publico/assinatura-config');
    if (!checkoutUrl) exibirPlano(config.plan);
    supportNumberLabel.textContent = `Suporte: ${config.suporteNumero || '--'}`;
    metodoPagamentoInput.innerHTML = '<option value="mercado_pago">Mercado Pago</option>';
    if (!Array.isArray(config.diasVencimento) || !config.diasVencimento.length) throw new Error('Configuracao de vencimento indisponivel.');
    diaVencimentoInput.innerHTML = config.diasVencimento
      .map((dia) => `<option value="${dia}">Dia ${dia}</option>`)
      .join('');
    if (config.gateway?.enabled === false) {
      cadastroConfigMessage.textContent = 'O pagamento esta temporariamente indisponivel. O cadastro pode ser salvo, mas o responsavel pelo sistema precisa configurar o Mercado Pago para liberar o checkout.';
    }
  } catch (error) {
    cadastroConfigMessage.textContent = `Nao consegui carregar a configuracao do cadastro. ${error.message}`;
  }
}

metodoPagamentoInput?.addEventListener('change', () => {
  metodoPagamentoInput.value = 'mercado_pago';
});

assinaturaForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (enviando) return;
  enviando = true;
  submitButton.disabled = true;
  submitButton.textContent = 'Cadastrando...';
  assinaturaForm.setAttribute('aria-busy', 'true');
  limparMonitorLiberacao();
  renderizarCheckout();
  mostrarMensagem('Salvando seu cadastro...');
  let cadastroSalvo = false;

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

    if (!Number.isSafeInteger(resposta.assinatura?.id) || resposta.assinatura.id <= 0) {
      throw new Error('O servidor nao confirmou o cadastro. Tente novamente.');
    }
    cadastroSalvo = true;
    authToken = null;
    gravarStorage(TOKEN_STORAGE_KEY, null);
    salvarCadastroPendente({ assinaturaId: resposta.assinatura.id, email: emailCadastro });
    mostrarMensagem('Cadastro salvo. Abrindo o pagamento no Mercado Pago...');
    const checkout = await buscarJson(`/api/publico/assinaturas/${resposta.assinatura.id}/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: senhaCadastro }),
    });
    if (typeof checkout.checkoutUrl !== 'string' || !/^https:\/\/([a-z0-9-]+\.)*mercadopago\.(com|com\.br)\//i.test(checkout.checkoutUrl)) {
      throw new Error('O Mercado Pago nao retornou uma URL de pagamento valida. Tente novamente.');
    }
    exibirPlano(checkout.plan);
    renderizarCheckout(checkout.checkoutUrl);
    iniciarMonitorLiberacao(resposta.assinatura.id, emailCadastro, senhaCadastro);
    mostrarMensagem('Redirecionando ao Mercado Pago. Se nao abrir, clique em Pagar com Mercado Pago.', true);
    window.location.assign(checkout.checkoutUrl);
  } catch (error) {
    mostrarMensagem(`${cadastroSalvo ? 'Cadastro salvo, mas nao foi possivel abrir o pagamento. ' : ''}${error.message}`, true);
  } finally {
    enviando = false;
    submitButton.disabled = false;
    submitButton.textContent = 'Cadastrar assinatura';
    assinaturaForm.removeAttribute('aria-busy');
  }
});

assinaturaForm.addEventListener('invalid', () => {
  mostrarMensagem('Confira os campos obrigatorios, o email e a senha de pelo menos 4 caracteres.');
}, true);

carregarConfiguracao();

const cadastroPendente = carregarCadastroPendente();
if (cadastroPendente?.assinaturaId) {
  assinaturaFormMessage.textContent = 'Aguardando confirmacao do Mercado Pago. Se ainda nao pagou, entre pela pagina inicial para continuar.';
  iniciarMonitorLiberacao(cadastroPendente.assinaturaId, cadastroPendente.email);
}
