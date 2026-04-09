const TOKEN_STORAGE_KEY = 'barbearia_auth_token';

const loginBarbeiroForm = document.getElementById('loginBarbeiroForm');
const loginBarbeiroMessage = document.getElementById('loginBarbeiroMessage');
const loginBlockedPixCard = document.getElementById('loginBlockedPixCard');
const loginBlockedPixFavorecidoLabel = document.getElementById('loginBlockedPixFavorecidoLabel');
const loginBlockedPixQrPanel = document.getElementById('loginBlockedPixQrPanel');
const loginBlockedPixQrImage = document.getElementById('loginBlockedPixQrImage');
const loginBlockedPixChaveLabel = document.getElementById('loginBlockedPixChaveLabel');
const abrirCadastroButtons = document.querySelectorAll('[data-open-cadastro]');
const abrirRecuperacaoButton = document.getElementById('abrirRecuperacaoButton');
let pixConfig = null;
let valorMensalAtual = 1;

function esconderPixBloqueado() {
  loginBlockedPixCard.hidden = true;
  loginBlockedPixQrPanel.hidden = true;
  loginBlockedPixQrImage.hidden = true;
  loginBlockedPixQrImage.removeAttribute('src');
}

async function buscarJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error || `Falha ao carregar ${url}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function mostrarPixBloqueado() {
  if (!pixConfig?.chave) {
    esconderPixBloqueado();
    return;
  }

  loginBlockedPixFavorecidoLabel.textContent = `Favorecido: ${pixConfig.favorecido}`;
  loginBlockedPixChaveLabel.textContent = `Chave Pix: ${pixConfig.chave}`;

  try {
    const pagamentoPix = await buscarJson('/api/publico/pix/qrcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valor: valorMensalAtual,
        descricao: 'Assinatura mensal Salãoflix',
      }),
    });

    loginBlockedPixQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(
      pagamentoPix.payload
    )}`;
    loginBlockedPixCard.hidden = false;
    loginBlockedPixQrPanel.hidden = false;
    loginBlockedPixQrImage.hidden = false;
  } catch (error) {
    console.error(error);
    esconderPixBloqueado();
  }
}

async function carregarConfiguracaoPublica() {
  try {
    const config = await buscarJson('/api/publico/assinatura-config');
    pixConfig = config.pix || null;
    valorMensalAtual = Number(config.valorMensal || 1);
  } catch (error) {
    console.error(error);
  }
}

abrirCadastroButtons.forEach((button) => {
  button.addEventListener('click', () => {
    window.open('/cadastro.html', '_blank', 'noopener');
  });
});

abrirRecuperacaoButton.addEventListener('click', () => {
  window.location.href = '/recuperar-senha.html';
});

document.querySelectorAll('[data-toggle-password]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);

    if (!input) {
      return;
    }

    const mostrar = input.type === 'password';
    input.type = mostrar ? 'text' : 'password';
    button.textContent = mostrar ? 'Ocultar' : 'Mostrar';
  });
});

loginBarbeiroForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  esconderPixBloqueado();

  try {
    const payload = await buscarJson('/api/barbeiro/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identificador: document.getElementById('loginIdentificadorInput').value.trim(),
        senha: document.getElementById('loginSenhaInput').value,
      }),
    });

    localStorage.setItem(TOKEN_STORAGE_KEY, payload.token);
    window.location.href = '/barbeiro.html';
  } catch (error) {
    console.error(error);
    loginBarbeiroMessage.textContent =
      error.status === 403 ? 'Sistema bloqueado. Regularize seu Pix.' : error.message;

    if (error.status === 403) {
      await mostrarPixBloqueado();
    }
  }
});

carregarConfiguracaoPublica();
