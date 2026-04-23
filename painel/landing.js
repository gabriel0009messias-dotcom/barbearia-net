const TOKEN_STORAGE_KEY = 'barbearia_auth_token';

const loginBarbeiroForm = document.getElementById('loginBarbeiroForm');
const loginBarbeiroMessage = document.getElementById('loginBarbeiroMessage');
const loginBlockedPixCard = document.getElementById('loginBlockedPixCard');
const loginBlockedPixValorLabel = document.getElementById('loginBlockedPixValorLabel');
const loginBlockedPixFavorecidoLabel = document.getElementById('loginBlockedPixFavorecidoLabel');
const loginBlockedPixQrPanel = document.getElementById('loginBlockedPixQrPanel');
const loginBlockedPixQrImage = document.getElementById('loginBlockedPixQrImage');
const loginBlockedPixChaveLabel = document.getElementById('loginBlockedPixChaveLabel');
const loginBlockedPixCopiaColaLabel = document.getElementById('loginBlockedPixCopiaColaLabel');
const loginBlockedWhatsappButton = document.getElementById('loginBlockedWhatsappButton');
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
    error.details = payload;
    throw error;
  }

  return payload;
}

function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function mostrarPixBloqueado(estado = {}) {
  const pix = estado?.pix || pixConfig;

  if (!pix?.copiaCola) {
    esconderPixBloqueado();
    return;
  }

  loginBlockedPixValorLabel.textContent = `Valor: ${formatarMoeda(pix.valor || valorMensalAtual)}`;
  loginBlockedPixFavorecidoLabel.textContent = `Favorecido: ${pix.favorecido || '--'}`;
  loginBlockedPixChaveLabel.textContent = `Chave Pix: ${pix.chaveExibicao || pix.chave || '--'}`;
  loginBlockedPixCopiaColaLabel.textContent = `Pix copia e cola: ${pix.copiaCola}`;
  loginBlockedWhatsappButton.href = pix.whatsappLink || '#';
  loginBlockedPixQrImage.src = pix.qrCodeImageUrl || '';
  loginBlockedPixCard.hidden = false;
  loginBlockedPixQrPanel.hidden = !pix.qrCodeImageUrl;
  loginBlockedPixQrImage.hidden = !pix.qrCodeImageUrl;
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
      error.status === 403 ? error.message || 'Sistema bloqueado. Regularize seu Pix.' : error.message;

    if (error.status === 403) {
      mostrarPixBloqueado(error.details || {});
    }
  }
});

carregarConfiguracaoPublica();
