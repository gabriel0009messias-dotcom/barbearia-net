const info = document.getElementById('resetPasswordInfo');
const form = document.getElementById('resetPasswordForm');
const message = document.getElementById('resetPasswordMessage');
const novaSenhaInput = document.getElementById('novaSenhaInput');
const confirmarSenhaInput = document.getElementById('confirmarSenhaInput');
const token = new URLSearchParams(window.location.search).get('token') || '';

async function buscarJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error || 'Não foi possível validar o link.');
    error.status = response.status;
    throw error;
  }

  return payload;
}

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

async function validarToken() {
  if (!token) {
    info.textContent = 'Link de recuperação inválido.';
    message.textContent = 'Abra novamente o link enviado para o seu e-mail.';
    return;
  }

  try {
    const payload = await buscarJson(`/api/barbeiro/recuperar-senha/token-status?token=${encodeURIComponent(token)}`);
    info.textContent = `Redefinindo senha de ${payload.email}.`;
    form.hidden = false;
  } catch (error) {
    console.error(error);
    info.textContent = error.message;
    message.textContent = 'Solicite um novo link de recuperação.';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = 'Salvando nova senha...';

  try {
    const payload = await buscarJson('/api/barbeiro/recuperar-senha/redefinir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        novaSenha: novaSenhaInput.value,
        confirmarSenha: confirmarSenhaInput.value,
      }),
    });

    message.textContent = payload.mensagem || 'Senha da sua conta Studiofy atualizada com sucesso.';
    form.hidden = true;
    info.textContent = 'Senha redefinida. Agora você pode voltar ao login e entrar na sua conta Studiofy.';
  } catch (error) {
    console.error(error);
    message.textContent = error.message;
  }
});

validarToken();
