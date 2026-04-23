const ADMIN_EMAIL = 'gabriel0009messias@gmail.com';
const ADMIN_SENHA = 'rios123456';

const adminLoginForm = document.getElementById('adminLoginForm');
const adminEmailInput = document.getElementById('adminEmailInput');
const adminSenhaInput = document.getElementById('adminSenhaInput');
const adminLoginMessage = document.getElementById('adminLoginMessage');

adminLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const email = adminEmailInput.value.trim().toLowerCase();
  const senha = adminSenhaInput.value;

  if (email !== ADMIN_EMAIL || senha !== ADMIN_SENHA) {
    adminLoginMessage.textContent = 'Email ou senha incorretos';
    return;
  }

  adminLoginMessage.textContent = '';

  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, senha }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload?.error || 'Nao foi possivel entrar.');
    }

    localStorage.setItem('barbearia_admin_token', payload.token);
    window.location.href = '/painel-admin/painel.html';
  } catch (error) {
    console.error(error);
    adminLoginMessage.textContent = 'Email ou senha incorretos';
  }
});
