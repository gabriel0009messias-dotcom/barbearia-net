const assinaturaCount = document.getElementById('assinaturaCount');
const totalAssinaturas = document.getElementById('totalAssinaturas');
const assinaturasAtivas = document.getElementById('assinaturasAtivas');
const assinaturasPendentes = document.getElementById('assinaturasPendentes');
const assinaturasTable = document.getElementById('assinaturasTable');
const refreshButton = document.getElementById('refreshButton');
const logoutButton = document.getElementById('logoutButton');
const suporteForm = document.getElementById('suporteForm');
const suporteNumeroInput = document.getElementById('suporteNumeroInput');
const suporteMessage = document.getElementById('suporteMessage');
const supportNumberLabel = document.getElementById('supportNumberLabel');
const cadastroLinkInput = document.getElementById('cadastroLinkInput');
const copiarCadastroLinkButton = document.getElementById('copiarCadastroLinkButton');
const cadastroLinkMessage = document.getElementById('cadastroLinkMessage');
const pagamentoResumo = document.getElementById('pagamentoResumo');
const vencimentoResumo = document.getElementById('vencimentoResumo');

const adminToken = localStorage.getItem('barbearia_admin_token');
let statusDisponiveis = ['pendente', 'ativo', 'bloqueado'];

if (!adminToken) {
  window.location.href = '/controle-interno';
}

// Exibir o link correto de cadastro conforme ambiente
const renderLink = 'https://barbearia-net.onrender.com/';
const hostname = window.location.hostname;
const usandoServidorLocal =
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '::1' ||
  hostname.endsWith('.local');

if (window.location.hostname.includes('onrender.com') || usandoServidorLocal) {
  cadastroLinkInput.value = renderLink;
} else {
  cadastroLinkInput.value = `${window.location.origin}/`;
}

function formatarData(data) {
  if (!data) return '-';
  return new Date(`${data}T00:00:00`).toLocaleDateString('pt-BR');
}

function escaparHtml(texto = '') {
  return String(texto)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function buscarJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken,
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem('barbearia_admin_token');
      window.location.href = '/controle-interno';
      return;
    }

    throw new Error(payload?.error || `Falha ao carregar ${url}`);
  }

  return payload;
}

function renderizarResumo(assinaturas) {
  const total = assinaturas.length;
  const ativas = assinaturas.filter((item) => item.status === 'ativo').length;
  const pendentes = assinaturas.filter((item) => item.status === 'pendente').length;
  const pix = assinaturas.filter((item) => item.metodo_pagamento === 'pix').length;
  const boleto = assinaturas.filter((item) => item.metodo_pagamento === 'boleto').length;
  const dia5 = assinaturas.filter((item) => Number(item.dia_vencimento) === 5).length;
  const dia19 = assinaturas.filter((item) => Number(item.dia_vencimento) === 19).length;
  const dia26 = assinaturas.filter((item) => Number(item.dia_vencimento) === 26).length;

  totalAssinaturas.textContent = String(total);
  assinaturasAtivas.textContent = String(ativas);
  assinaturasPendentes.textContent = String(pendentes);
  assinaturaCount.textContent = `${total} cadastros`;
  pagamentoResumo.textContent = `PIX: ${pix} | BOLETO: ${boleto}`;
  vencimentoResumo.textContent = `Vencimentos 5: ${dia5} | 19: ${dia19} | 26: ${dia26}`;
}

function montarOpcoesStatus(statusAtual) {
  return statusDisponiveis
    .map(
      (status) =>
        `<option value="${status}" ${status === statusAtual ? 'selected' : ''}>${status.toUpperCase()}</option>`
    )
    .join('');
}

function resumirServicos(servicos = []) {
  if (!servicos.length) {
    return '-';
  }

  return servicos
    .map((item) => `${item.nome} (${Number(item.preco).toFixed(2).replace('.', ',')})`)
    .join(', ');
}

function renderizarAssinaturas(assinaturas) {
  if (!assinaturas.length) {
    assinaturasTable.innerHTML = '<tr><td colspan="11">Nenhuma assinatura cadastrada.</td></tr>';
    return;
  }

  assinaturasTable.innerHTML = assinaturas
    .map(
      (item) => `
        <tr>
          <td>
            <strong>${escaparHtml(item.barbearia_nome)}</strong><br />
            <small>${escaparHtml(item.telefone || '-')}</small>
          </td>
          <td>
            ${escaparHtml(item.responsavel_nome || '-')}<br />
            <small>${escaparHtml(item.email || '-')}</small>
          </td>
          <td>
            ${escaparHtml((item.metodo_pagamento || '-').toUpperCase())}<br />
            <small>R$ ${Number(item.valor_mensal || 0).toFixed(2).replace('.', ',')}</small>
          </td>
          <td>
            <small>Inicio: ${formatarData(item.trial_started_at?.slice(0, 10))}</small><br />
            <small>Fim: ${formatarData(item.trial_expires_at?.slice(0, 10))}</small>
          </td>
          <td>
            Dia ${escaparHtml(String(item.dia_vencimento || '-'))}<br />
            <small>Prox.: ${formatarData(item.proximo_vencimento)}</small>
          </td>
          <td>
            ${escaparHtml(item.whatsapp_numero || '-')}<br />
            <small>${escaparHtml(item.whatsapp_status || 'nao_configurado')}</small>
          </td>
          <td>
            <select class="status-select" data-field="status" data-id="${item.id}">
              ${montarOpcoesStatus(item.status)}
            </select>
          </td>
          <td>
            <input
              class="inline-input"
              data-field="ultimoPagamento"
              data-id="${item.id}"
              type="date"
              value="${item.ultimo_pagamento || ''}"
            />
          </td>
          <td>
            <input
              class="inline-input"
              data-field="observacoes"
              data-id="${item.id}"
              type="text"
              maxlength="160"
              value="${escaparHtml(item.observacoes || '')}"
              placeholder="Ex.: pagou no Pix"
            />
          </td>
          <td><small>${escaparHtml(resumirServicos(item.servicos))}</small></td>
          <td>
            <button class="table-action" data-action="salvar" data-id="${item.id}" type="button">Salvar</button>
          </td>
          <td>
            <button class="table-action danger" data-action="excluir" data-id="${item.id}" type="button">Excluir</button>
          </td>
        </tr>
      `
    )
    .join('');
}

async function carregarPainelAdmin() {
  try {
    suporteMessage.textContent = '';

    const [config, assinaturas] = await Promise.all([
      buscarJson('/api/admin/assinatura-config', { method: 'GET' }),
      buscarJson('/api/admin/assinaturas', { method: 'GET' }),
    ]);

    statusDisponiveis = config.statusDisponiveis || statusDisponiveis;
    suporteNumeroInput.value = config.suporteNumero || '';
    supportNumberLabel.textContent = `Suporte: ${config.suporteNumero || '--'}`;

    renderizarResumo(assinaturas);
    renderizarAssinaturas(assinaturas);
  } catch (error) {
    console.error(error);
    suporteMessage.textContent = 'Nao consegui carregar seu painel admin.';
  }
}

suporteForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const atualizado = await buscarJson('/api/admin/assinatura-config', {
      method: 'PATCH',
      body: JSON.stringify({ suporteNumero: suporteNumeroInput.value.trim() }),
    });

    supportNumberLabel.textContent = `Suporte: ${atualizado.suporteNumero || '--'}`;
    suporteMessage.textContent = 'Numero de suporte atualizado com sucesso.';
  } catch (error) {
    console.error(error);
    suporteMessage.textContent = 'Nao consegui atualizar o numero de suporte.';
  }
});

assinaturasTable.addEventListener('click', async (event) => {
  const botaoSalvar = event.target.closest('button[data-action="salvar"]');
  const botaoExcluir = event.target.closest('button[data-action="excluir"]');

  if (botaoSalvar) {
    const { id } = botaoSalvar.dataset;
    const status = document.querySelector(`[data-field="status"][data-id="${id}"]`)?.value;
    const ultimoPagamento = document.querySelector(`[data-field="ultimoPagamento"][data-id="${id}"]`)?.value;
    const observacoes = document.querySelector(`[data-field="observacoes"][data-id="${id}"]`)?.value;

    try {
      botaoSalvar.disabled = true;
      await buscarJson(`/api/admin/assinaturas/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, ultimoPagamento, observacoes }),
      });

      suporteMessage.textContent = 'Assinatura atualizada com sucesso.';
      await carregarPainelAdmin();
    } catch (error) {
      console.error(error);
      suporteMessage.textContent = 'Nao consegui salvar essa assinatura.';
    } finally {
      botaoSalvar.disabled = false;
    }
    return;
  }

  if (botaoExcluir) {
    const { id } = botaoExcluir.dataset;
    if (!confirm('Tem certeza que deseja excluir este cliente? Esta ação não pode ser desfeita.')) {
      return;
    }
    try {
      botaoExcluir.disabled = true;
      await buscarJson(`/api/admin/assinaturas/${id}`, {
        method: 'DELETE'
      });
      suporteMessage.textContent = 'Assinatura excluída com sucesso.';
      await carregarPainelAdmin();
    } catch (error) {
      console.error(error);
      suporteMessage.textContent = 'Nao consegui excluir essa assinatura.';
    } finally {
      botaoExcluir.disabled = false;
    }
    return;
  }
});

refreshButton.addEventListener('click', carregarPainelAdmin);

logoutButton.addEventListener('click', () => {
  localStorage.removeItem('barbearia_admin_token');
  window.location.href = '/controle-interno';
});

copiarCadastroLinkButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cadastroLinkInput.value);
    cadastroLinkMessage.textContent = 'Link copiado. Agora e so colar e enviar para o barbeiro.';
  } catch (error) {
    console.error(error);
    cadastroLinkInput.select();
    cadastroLinkMessage.textContent = 'Nao consegui copiar automaticamente. O link ja ficou selecionado para copiar.';
  }
});

carregarPainelAdmin();
