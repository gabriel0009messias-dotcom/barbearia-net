const form = document.getElementById('recuperacaoLinkForm');
const emailInput = document.getElementById('recuperacaoEmailInput');
const message = document.getElementById('recuperacaoLinkMessage');

async function buscarJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error || 'Nao foi possivel enviar o link de recuperacao.');
    error.status = response.status;
    throw error;
  }

  return payload;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = 'Enviando link de recuperacao...';

  try {
    const payload = await buscarJson('/api/barbeiro/recuperar-senha/solicitar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: emailInput.value.trim(),
      }),
    });

    message.textContent = payload.mensagem || 'Link enviado com sucesso.';
    form.reset();
  } catch (error) {
    console.error(error);
    message.textContent = error.message;
  }
});
