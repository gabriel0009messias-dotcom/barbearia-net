const adminTokenKey = 'admin_token_salaoflix';

const adminLoginCard = document.getElementById('adminLoginCard');
const adminPanel = document.getElementById('adminPanel');
const adminLoginForm = document.getElementById('adminLoginForm');
const adminPinInput = document.getElementById('adminPinInput');
const adminLoginMessage = document.getElementById('adminLoginMessage');
const adminResumo = document.getElementById('adminResumo');
const adminResumoLista = document.getElementById('adminResumoLista');
const adminAssinaturasBody = document.getElementById('adminAssinaturasBody');
const adminTableMessage = document.getElementById('adminTableMessage');
const adminSuporteInput = document.getElementById('adminSuporteInput');
const salvarSuporteButton = document.getElementById('salvarSuporteButton');
const recarregarAdminButton = document.getElementById('recarregarAdminButton');
const sairAdminButton = document.getElementById('sairAdminButton');

function getAdminToken() {
  return window.localStorage.getItem(adminTokenKey) || '';
}

function setAdminToken(token) {
  window.localStorage.setItem(adminTokenKey, token);
}

function clearAdminToken() {
  window.localStorage.removeItem(adminTokenKey);
}

async function buscarJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getAdminToken();

  if (token) {
    headers.set('x-admin-token', token);
  }

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Falha ao carregar dados do admin.');
  }

  return data;
}

function contarStatus(assinaturas) {
  const resumo = {
    total: assinaturas.length,
    ativo: 0,
    pendente: 0,
    bloqueado: 0,
  };

  for (const assinatura of assinaturas) {
    const status = String(assinatura.status || '').toLowerCase();
    if (status in resumo) {
      resumo[status] += 1;
    }
  }

  return resumo;
}

function renderResumo(assinaturas) {
  const resumo = contarStatus(assinaturas);
  adminResumo.textContent = `${resumo.total} assinaturas cadastradas no sistema.`;
  adminResumoLista.innerHTML = `
    <li>Total: <strong>${resumo.total}</strong></li>
    <li>Ativos: <strong>${resumo.ativo}</strong></li>
    <li>Pendentes: <strong>${resumo.pendente}</strong></li>
    <li>Bloqueados: <strong>${resumo.bloqueado}</strong></li>
  `;
}

function montarLinhaAssinatura(assinatura) {
  const tr = document.createElement('tr');
  const contato = [assinatura.email, assinatura.telefone].filter(Boolean).join(' / ');
  const pagamento = `${assinatura.metodo_pagamento || '--'} / dia ${assinatura.dia_vencimento || '--'}`;

  tr.innerHTML = `
    <td>${assinatura.barbearia_nome || '--'}</td>
    <td>${assinatura.responsavel_nome || '--'}</td>
    <td>${contato || '--'}</td>
    <td>${pagamento}</td>
    <td>
      <select class="status-select">
        <option value="pendente"${assinatura.status === 'pendente' ? ' selected' : ''}>Pendente</option>
        <option value="ativo"${assinatura.status === 'ativo' ? ' selected' : ''}>Ativo</option>
        <option value="bloqueado"${assinatura.status === 'bloqueado' ? ' selected' : ''}>Bloqueado</option>
      </select>
    </td>
    <td><button class="table-action danger-button" type="button">Salvar</button></td>
  `;

  const select = tr.querySelector('select');
  const button = tr.querySelector('button');

  button.addEventListener('click', async () => {
    button.disabled = true;
    adminTableMessage.textContent = 'Salvando status...';

    try {
      await buscarJson(`/api/admin/assinaturas/${assinatura.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: select.value,
          ultimoPagamento: new Date().toISOString().slice(0, 10),
        }),
      });

      adminTableMessage.textContent = 'Status atualizado com sucesso.';
      await carregarPainelAdmin();
    } catch (error) {
      adminTableMessage.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  return tr;
}

async function carregarPainelAdmin() {
  const [config, assinaturas] = await Promise.all([
    buscarJson('/api/admin/assinatura-config'),
    buscarJson('/api/admin/assinaturas'),
  ]);

  adminSuporteInput.value = config.suporteNumero || '';
  renderResumo(assinaturas);
  adminAssinaturasBody.innerHTML = '';

  if (!assinaturas.length) {
    adminAssinaturasBody.innerHTML = '<tr><td colspan="6">Nenhuma assinatura cadastrada.</td></tr>';
    return;
  }

  assinaturas.forEach((assinatura) => {
    adminAssinaturasBody.appendChild(montarLinhaAssinatura(assinatura));
  });
}

async function iniciarSessaoAdmin() {
  adminLoginCard.hidden = true;
  adminPanel.hidden = false;
  adminTableMessage.textContent = '';

  try {
    await carregarPainelAdmin();
  } catch (error) {
    clearAdminToken();
    adminPanel.hidden = true;
    adminLoginCard.hidden = false;
    adminLoginMessage.textContent = error.message;
  }
}

adminLoginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  adminLoginMessage.textContent = 'Entrando...';

  try {
    const payload = await buscarJson('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ pin: adminPinInput.value.trim() }),
    });

    setAdminToken(payload.token);
    adminLoginMessage.textContent = '';
    await iniciarSessaoAdmin();
  } catch (error) {
    adminLoginMessage.textContent = error.message;
  }
});

salvarSuporteButton?.addEventListener('click', async () => {
  adminTableMessage.textContent = 'Salvando suporte...';

  try {
    await buscarJson('/api/admin/assinatura-config', {
      method: 'PATCH',
      body: JSON.stringify({ suporteNumero: adminSuporteInput.value.trim() }),
    });
    adminTableMessage.textContent = 'Suporte atualizado com sucesso.';
  } catch (error) {
    adminTableMessage.textContent = error.message;
  }
});

recarregarAdminButton?.addEventListener('click', async () => {
  adminTableMessage.textContent = 'Atualizando...';

  try {
    await carregarPainelAdmin();
    adminTableMessage.textContent = 'Painel atualizado.';
  } catch (error) {
    adminTableMessage.textContent = error.message;
  }
});

sairAdminButton?.addEventListener('click', () => {
  clearAdminToken();
  adminPanel.hidden = true;
  adminLoginCard.hidden = false;
  adminLoginMessage.textContent = '';
  adminPinInput.value = '';
});

if (getAdminToken()) {
  iniciarSessaoAdmin();
}
