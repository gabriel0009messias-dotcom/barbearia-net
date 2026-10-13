function rotuloAcesso(account) {
  if (account.bloqueio_admin || account.acesso?.status === 'admin_blocked') return 'Bloqueada administrativamente';
  return ({ trial_active: 'Trial ativo', trial_expired: 'Trial expirado', subscription_active: 'Assinatura ativa', grace_period: 'Tolerância', manual_access: 'Liberação manual', subscription_irregular: 'Assinatura requer regularização' })[account.acesso?.status] || (account.acesso?.motivo === 'subscription_expired' ? 'Assinatura expirada' : 'Aguardando pagamento');
}
let adminToken = '';
// Discard persistence from previous versions; never read or reuse its token.
try {
  window.localStorage.removeItem('admin_token_salaoflix');
  window.localStorage.removeItem('barbearia_admin_token');
  window.localStorage.removeItem('admin_token_salaoflix_inline');
} catch {}

const adminLoginCard = document.getElementById('adminLoginCard');
const adminPanel = document.getElementById('adminPanel');
const adminLoginForm = document.getElementById('adminLoginForm');
const adminEmailInput = document.getElementById('adminEmailInput');
const adminSenhaInput = document.getElementById('adminSenhaInput');
const adminLoginMessage = document.getElementById('adminLoginMessage');
const adminResumo = document.getElementById('adminResumo');
const adminResumoLista = document.getElementById('adminResumoLista');
const adminAssinaturasBody = document.getElementById('adminAssinaturasBody');
const adminPendentesBody = document.getElementById('adminPendentesBody');
const adminTableMessage = document.getElementById('adminTableMessage');
const adminSuporteInput = document.getElementById('adminSuporteInput');
const salvarSuporteButton = document.getElementById('salvarSuporteButton');
const recarregarAdminButton = document.getElementById('recarregarAdminButton');
const sairAdminButton = document.getElementById('sairAdminButton');
const adminLiberacaoForm = document.getElementById('adminLiberacaoForm');
const adminLiberacaoMessage = document.getElementById('adminLiberacaoMessage');
let carregandoAdmin = false;
adminSuporteInput?.addEventListener('input', () => { adminSuporteInput.dataset.alterado = 'true'; });


function getAdminToken() {
  return adminToken;
}

function setAdminToken(token) {
  adminToken = token;
}

function clearAdminToken() {
  adminToken = '';
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
    regularizacao: 0,
  };

  for (const assinatura of assinaturas) {
    if (assinatura.bloqueio_admin || assinatura.acesso?.status === 'admin_blocked') { resumo.bloqueado += 1; continue; }
    if (assinatura.acesso?.status === 'subscription_irregular') { resumo.regularizacao += 1; continue; }
    const original = String(assinatura.status || '').toLowerCase();
    const status = ({ ativa: 'ativo', bloqueada: 'bloqueado' })[original] || original;
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
    <li>Requerem regularização: <strong>${resumo.regularizacao}</strong></li>
  `;
}

function montarLinhaAssinatura(assinatura, pendente = false) {
  const adminTableMessage = document.getElementById(pendente ? 'adminPendentesMessage' : 'adminTableMessage');
  const tr = document.createElement('tr');
  const status = ({ ativa: 'ativo', bloqueada: 'bloqueado' })[assinatura.status] || assinatura.status;
  const telefones = [
    assinatura.telefone && `Telefone: ${assinatura.telefone}`,
    assinatura.whatsapp_numero && `WhatsApp: ${assinatura.whatsapp_numero}`,
  ].filter(Boolean).join(' / ');
  const contato = [assinatura.email, telefones].filter(Boolean).join(' / ');
  const pagamento = `${assinatura.metodo_pagamento || '--'} / dia ${assinatura.dia_vencimento || '--'}`;

  tr.innerHTML = `
    <td></td><td></td><td></td><td></td>
    <td>
      <select class="status-select">
        <option value="pendente"${status === 'pendente' ? ' selected' : ''}>Pendente</option>
        <option value="ativo"${status === 'ativo' ? ' selected' : ''}>Ativo</option>
        <option value="bloqueado"${status === 'bloqueado' ? ' selected' : ''}>Bloqueado</option>
      </select>
    </td>
    <td><button class="table-action danger-button save-status" type="button">Salvar</button> <button class="table-action grant-days" type="button">Liberar dias</button> <button class="table-action danger-button delete-account" type="button">Excluir</button></td>
  `;

  if (!pendente) { const label = document.createElement('small'); label.style.display = 'block'; label.textContent = rotuloAcesso(assinatura); tr.cells[4].appendChild(label); }
  let values = [assinatura.barbearia_nome, assinatura.responsavel_nome, contato, pagamento];
  if (pendente) {
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td><td></td><td></td>' +
      '<td><button class="table-action grant-days" type="button">Liberar acesso manualmente</button> ' +
      '<button class="table-action danger-button delete-account" type="button">Excluir cadastro</button></td>';
    const cadastro = new Date(assinatura.created_at);
    values = [assinatura.barbearia_nome, assinatura.responsavel_nome, assinatura.email,
      telefones,
      assinatura.metodo_pagamento === 'mercado_pago' ? 'Mercado Pago' : assinatura.metodo_pagamento,
      rotuloAcesso(assinatura), assinatura.created_at && Number.isFinite(cadastro.getTime()) ? cadastro.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '--'];
  }
  values.forEach((value, index) => {
    tr.cells[index].textContent = value || '--';
  });
  if (Date.parse(assinatura.acesso_manual_ate || '') > Date.now()) {
    const prazo = document.createElement('small');
    prazo.style.display = 'block';
    prazo.textContent = `Acesso gratuito ate ${new Date(assinatura.acesso_manual_ate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
    tr.cells[4].appendChild(prazo);
  }
  const grantButton = tr.querySelector('.grant-days');
  async function liberarDias() {
    const value = window.prompt(`Registrar dias sem pagamento para ${assinatura.barbearia_nome || 'esta conta'} por quantos dias a partir de agora? (1 a 365)\nEsta ação não retira bloqueio administrativo.`, '1');
    if (value === null) return;
    const dias = Number(value);
    if (!/^\d+$/.test(value.trim()) || !Number.isInteger(dias) || dias < 1 || dias > 365) {
      adminTableMessage.textContent = 'Informe de 1 a 365 dias inteiros.';
      return;
    }
    tr.querySelectorAll('button').forEach(node => { node.disabled = true; });
    adminTableMessage.textContent = 'Liberando acesso...';
    try {
      const result = await buscarJson(`/api/admin/assinaturas/${assinatura.id}/liberar-dias`, {
        method: 'POST', body: JSON.stringify({ dias }),
      });
      if (result.sucesso !== true || result.id !== assinatura.id) throw new Error('Atualize a lista para conferir a liberacao.');
      adminTableMessage.textContent = `Dias registrados ate ${new Date(result.acesso_manual_ate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.${result.bloqueio_admin ? ' O bloqueio administrativo permanece.' : ''}`;
      try { await carregarPainelAdmin(); } catch { adminTableMessage.textContent = 'Acesso liberado. Recarregue a lista para ver o prazo.'; }
    } catch (error) {
      adminTableMessage.textContent = error.message;
    } finally {
      tr.querySelectorAll('button').forEach(node => { node.disabled = false; });
    }
  }
  grantButton.addEventListener('click', liberarDias);
  if (assinatura.bloqueio_admin) {
    const unlock = document.createElement('button');
    unlock.type = 'button';
    unlock.className = 'table-action unlock-account';
    unlock.textContent = 'Retirar bloqueio administrativo';
    tr.lastElementChild.appendChild(unlock);
    unlock.addEventListener('click', async () => {
      if (!window.confirm('Retirar somente o bloqueio administrativo? O acesso ainda depende do trial, pagamento ou prazo manual.')) return;
      unlock.disabled = true;
      try {
        await buscarJson(`/api/admin/assinaturas/${assinatura.id}/desbloquear`, { method: 'POST' });
        adminTableMessage.textContent = 'Bloqueio administrativo retirado.';
        await carregarPainelAdmin();
      } catch (error) { adminTableMessage.textContent = error.message; }
      finally { unlock.disabled = false; }
    });
  }
  const deleteButton = tr.querySelector('.delete-account');
  deleteButton.addEventListener('click', async () => {
    if (!window.confirm('Tem certeza que deseja excluir esta conta? Esta ação não poderá ser desfeita.')) return;
    deleteButton.disabled = true;
    grantButton.disabled = true;
    if (button) button.disabled = true;
    adminTableMessage.textContent = 'Excluindo conta...';
    try {
      const result = await buscarJson(`/api/admin/assinaturas/${assinatura.id}`, {
        method: 'DELETE', body: JSON.stringify({ confirmationToken: assinatura.deleteConfirmationToken }),
      });
      if (result.sucesso !== true || result.id !== assinatura.id) throw new Error('Nao foi possivel confirmar a exclusao. Atualize a lista.');
      tr.remove();
      adminTableMessage.textContent = 'Conta excluida com sucesso.';
      try { await carregarPainelAdmin(); } catch { adminTableMessage.textContent = 'Conta excluida. Recarregue a lista para atualizar o resumo.'; }
    } catch (error) {
      adminTableMessage.textContent = error instanceof TypeError ? 'Falha de conexao. Verifique a lista antes de tentar novamente.' : error.message;
    } finally {
      deleteButton.disabled = false;
      grantButton.disabled = false;
      if (button) button.disabled = false;
    }
  });
  const select = tr.querySelector('select');
  select?.addEventListener('change', () => { select.dataset.alterado = 'true'; });
  const button = tr.querySelector('.save-status');

  button?.addEventListener('click', async () => {
    if (select.value === 'ativo') {
      if (status === 'ativo') {
        adminTableMessage.textContent = 'Esta conta ja esta ativa. Use Liberar dias para conceder acesso temporario.';
        return;
      }
      await liberarDias();
      return;
    }
    button.disabled = true;
    deleteButton.disabled = true;
    grantButton.disabled = true;
    adminTableMessage.textContent = 'Salvando status...';

    try {
      await buscarJson(`/api/admin/assinaturas/${assinatura.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: select.value }),
      });

      adminTableMessage.textContent = 'Status atualizado com sucesso.';
      await carregarPainelAdmin();
    } catch (error) {
      adminTableMessage.textContent = error.message;
    } finally {
      button.disabled = false;
      deleteButton.disabled = false;
      grantButton.disabled = false;
    }
  });

  return tr;
}

async function carregarPainelAdmin() {
  if (carregandoAdmin) return;
  carregandoAdmin = true;
  try {
    const [config, grupos] = await Promise.all([
      buscarJson('/api/admin/assinatura-config'),
      buscarJson('/api/admin/assinaturas?incluirPendentes=1'),
    ]);
    const { assinaturas, pendentes } = grupos;

    if (adminSuporteInput.dataset.alterado !== 'true') adminSuporteInput.value = config.suporteNumero || '';
    renderResumo(assinaturas);
    adminAssinaturasBody.innerHTML = '';

    if (!assinaturas.length) {
      adminAssinaturasBody.innerHTML = '<tr><td colspan="6">Nenhuma assinatura com pagamento aprovado ou liberacao manual.</td></tr>';
    }

    assinaturas.forEach((assinatura) => {
      adminAssinaturasBody.appendChild(montarLinhaAssinatura(assinatura));
    });
    adminPendentesBody.innerHTML = '';
    if (!pendentes.length) adminPendentesBody.innerHTML = '<tr><td colspan="8">Nenhum cadastro aguardando pagamento.</td></tr>';
    pendentes.forEach(assinatura => adminPendentesBody.appendChild(montarLinhaAssinatura(assinatura, true)));
  } finally {
    carregandoAdmin = false;
  }
}

adminLiberacaoForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const email = document.getElementById('adminLiberacaoEmail').value.trim();
  const dias = Number(document.getElementById('adminLiberacaoDias').value);
  if (!Number.isInteger(dias) || dias < 1 || dias > 365) {
    adminLiberacaoMessage.textContent = 'Informe de 1 a 365 dias inteiros.';
    return;
  }
  const button = adminLiberacaoForm.querySelector('button');
  button.disabled = true;
  adminLiberacaoMessage.textContent = 'Buscando cadastro...';
  try {
    const account = await buscarJson(`/api/admin/assinaturas/por-email?email=${encodeURIComponent(email)}`);
    if (!window.confirm(`Liberar ${dias} dia(s) sem pagamento para ${account.barbearia_nome} (${account.email})?`)) {
      adminLiberacaoMessage.textContent = 'Liberacao cancelada.';
      return;
    }
    const result = await buscarJson(`/api/admin/assinaturas/${account.id}/liberar-dias`, {
      method: 'POST', body: JSON.stringify({ dias }),
    });
    if (result.sucesso !== true || result.id !== account.id) throw new Error('Atualize a lista para conferir a liberacao.');
    adminLiberacaoMessage.textContent = `Dias registrados ate ${new Date(result.acesso_manual_ate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.${result.bloqueio_admin ? ' O bloqueio administrativo permanece.' : ''}`;
    try { await carregarPainelAdmin(); } catch { adminLiberacaoMessage.textContent = 'Acesso liberado. Recarregue a lista para ver o cliente.'; }
  } catch (error) {
    adminLiberacaoMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

window.setInterval(() => {
  if (adminPanel.hidden || document.hidden || carregandoAdmin ||
      adminPanel.querySelector('button:disabled, select[data-alterado="true"]') ||
      document.activeElement?.tagName === 'SELECT') return;
  carregarPainelAdmin().catch(() => {});
}, 30000);

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

async function fazerLoginAdmin(email, senha) {
  const payload = await buscarJson('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ email, senha }),
  });

  setAdminToken(payload.token);
  adminLoginMessage.textContent = '';
  await iniciarSessaoAdmin();
}

adminLoginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  adminLoginMessage.textContent = 'Entrando...';

  try {
    await fazerLoginAdmin(adminEmailInput.value.trim(), adminSenhaInput.value);
  } catch (error) {
    adminLoginMessage.textContent = error.message;
  } finally {
    adminSenhaInput.value = '';
  }
});

salvarSuporteButton?.addEventListener('click', async () => {
  adminTableMessage.textContent = 'Salvando suporte...';

  try {
    const resposta = await buscarJson('/api/admin/assinatura-config', {
      method: 'PATCH',
      body: JSON.stringify({ suporteNumero: adminSuporteInput.value.trim() }),
    });
    adminSuporteInput.value = resposta.suporteNumero || adminSuporteInput.value;
    delete adminSuporteInput.dataset.alterado;
    await carregarPainelAdmin();
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

sairAdminButton?.addEventListener('click', async () => {
  try { await buscarJson('/api/admin/logout', { method: 'POST' }); } catch {}
  clearAdminToken();
  adminPanel.hidden = true;
  adminLoginCard.hidden = false;
  adminLoginMessage.textContent = '';
  adminEmailInput.value = '';
  adminSenhaInput.value = '';
});

adminEmailInput.value = '';
adminSenhaInput.value = '';
