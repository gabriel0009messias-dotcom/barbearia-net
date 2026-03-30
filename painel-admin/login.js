const adminLoginForm = document.getElementById('adminLoginForm');
const adminPinInput = document.getElementById('adminPinInput');
const adminLoginMessage = document.getElementById('adminLoginMessage');

adminLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: adminPinInput.value }),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload?.error || 'Nao foi possivel entrar.');
    }

    localStorage.setItem('barbearia_admin_token', payload.token);
    window.location.href = '/controle-interno/painel';
  } catch (error) {
    console.error(error);
    adminLoginMessage.textContent = 'PIN invalido ou acesso indisponivel.';
  }
});
