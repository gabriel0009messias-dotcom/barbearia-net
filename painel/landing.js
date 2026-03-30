const TOKEN_STORAGE_KEY = 'barbearia_auth_token';

const loginBarbeiroForm = document.getElementById('loginBarbeiroForm');
const loginBarbeiroMessage = document.getElementById('loginBarbeiroMessage');
const abrirCadastroButtons = document.querySelectorAll('[data-open-cadastro]');
const abrirRecuperacaoButton = document.getElementById('abrirRecuperacaoButton');
const fecharRecuperacaoButton = document.getElementById('fecharRecuperacaoButton');
const recuperacaoModal = document.getElementById('recuperacaoModal');
const recuperacaoBackdrop = document.getElementById('recuperacaoBackdrop');
const recuperacaoSolicitarForm = document.getElementById('recuperacaoSolicitarForm');
const recuperacaoRedefinirForm = document.getElementById('recuperacaoRedefinirForm');
const recuperacaoMessage = document.getElementById('recuperacaoMessage');

function abrirRecuperacao() {
  recuperacaoModal.hidden = false;
  recuperacaoMessage.textContent = '';
}

function fecharRecuperacao() {
  recuperacaoModal.hidden = true;
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

abrirCadastroButtons.forEach((button) => {
  button.addEventListener('click', () => {
    window.open('/cadastro.html', '_blank', 'noopener');
  });
});

abrirRecuperacaoButton.addEventListener('click', abrirRecuperacao);
fecharRecuperacaoButton.addEventListener('click', fecharRecuperacao);
recuperacaoBackdrop.addEventListener('click', fecharRecuperacao);
recuperacaoModal.addEventListener('click', (event) => {
  if (event.target === recuperacaoModal) {
    fecharRecuperacao();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !recuperacaoModal.hidden) {
    fecharRecuperacao();
  }
});

loginBarbeiroForm.addEventListener('submit', async (event) => {
  event.preventDefault();

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
    loginBarbeiroMessage.textContent = error.message;
  }
});

recuperacaoSolicitarForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const payload = await buscarJson('/api/barbeiro/recuperar-senha/solicitar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metodo: document.getElementById('recuperacaoMetodoInput').value,
        identificador: document.getElementById('recuperacaoIdentificadorInput').value.trim(),
      }),
    });

    recuperacaoMessage.textContent = payload.mensagem;
  } catch (error) {
    console.error(error);
    recuperacaoMessage.textContent = error.message;
  }
});

recuperacaoRedefinirForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const payload = await buscarJson('/api/barbeiro/recuperar-senha/redefinir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identificador: document.getElementById('recuperacaoIdentificadorInput').value.trim(),
        codigo: document.getElementById('recuperacaoCodigoInput').value.trim(),
        novaSenha: document.getElementById('recuperacaoNovaSenhaInput').value,
      }),
    });

    recuperacaoMessage.textContent = payload.mensagem;
  } catch (error) {
    console.error(error);
    recuperacaoMessage.textContent = error.message;
  }
});
