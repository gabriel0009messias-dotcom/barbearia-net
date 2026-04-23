const assinaturaCount = document.getElementById('assinaturaCount');
const totalAssinaturas = document.getElementById('totalAssinaturas');
const assinaturasAtivas = document.getElementById('assinaturasAtivas');
const assinaturasPendentes = document.getElementById('assinaturasPendentes');
const assinaturasBloqueadas = document.getElementById('assinaturasBloqueadas');
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
const pixResumo = document.getElementById('pixResumo');
const filtroButtons = Array.from(document.querySelectorAll('[data-filtro-status]'));

const adminToken = localStorage.getItem('barbearia_admin_token');
const renderLink = 'https://barbearia-net.onrender.com/';

let assinaturasCache = [];
let filtroStatusAtual = 'todos';

if (!adminToken) {
  window.location.href = '/controle-interno';
}

cadastroLinkInput.value = renderLink;

function formatarData(data) {
  if (!data) {
    return '-';
  }

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

function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
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
      return null;
    }

    throw new Error(payload?.error || `Falha ao carregar ${url}`);
  }

  return payload;
}

function renderizarResumo(assinaturas, config) {
  const total = assinaturas.length;
  const ativas = assinaturas.filter((item) => item.status === 'ativo').length;
  const pendentes = assinaturas.filter((item) => item.status === 'pendente').length;
  const bloqueadas = assinaturas.filter((item) => item.status === 'bloqueado').length;
  const pix = assinaturas.filter((item) => item.metodo_pagamento === 'pix').length;
  const dia5 = assinaturas.filter((item) => Number(item.dia_vencimento) === 5).length;
  const dia12 = assinaturas.filter((item) => Number(item.dia_vencimento) === 12).length;
  const dia24 = assinaturas.filter((item) => Number(item.dia_vencimento) === 24).length;

  totalAssinaturas.textContent = String(total);
  assinaturasAtivas.textContent = String(ativas);
  assinaturasPendentes.textContent = String(pendentes);
  assinaturasBloqueadas.textContent = String(bloqueadas);
  pagamentoResumo.textContent = `Pix: ${pix}`;
  vencimentoResumo.textContent = `Vencimentos 5: ${dia5} | 12: ${dia12} | 24: ${dia24}`;
  pixResumo.textContent = config?.pix?.copiaCola
    ? `Valor fixo ${formatarMoeda(config.pix.valor)} | Chave ${config.pix.chaveExibicao || config.pix.chave}`
    : 'QR Code e copia e cola fixos para todos os clientes.';
}

function obterAssinaturasFiltradas() {
  if (filtroStatusAtual === 'todos') {
    return assinaturasCache;
  }

  return assinaturasCache.filter((item) => item.status === filtroStatusAtual);
}

function atualizarFiltroAtivo() {
  filtroButtons.forEach((button) => {
    button.classList.toggle('is-active-filter', button.dataset.filtroStatus === filtroStatusAtual);
  });
}

function classeStatus(status) {
  const atual = String(status || '').toLowerCase();

  if (atual === 'ativo') {
    return 'status-chip status-chip-ativo';
  }

  if (atual === 'pendente') {
    return 'status-chip status-chip-pendente';
  }

  return 'status-chip status-chip-bloqueado';
}

function renderizarAssinaturas() {
  const assinaturas = obterAssinaturasFiltradas();
  assinaturaCount.textContent = `${assinaturas.length} cadastros`;
  atualizarFiltroAtivo();

  if (!assinaturas.length) {
    assinaturasTable.innerHTML = '<tr><td colspan="10">Nenhum cliente encontrado nesse filtro.</td></tr>';
    return;
  }

  assinaturasTable.innerHTML = assinaturas
    .map(
      (item) => `
        <tr>
          <td>
            <strong>${escaparHtml(item.barbearia_nome)}</strong><br />
            <small>${escaparHtml(item.responsavel_nome || '-')}</small>
          </td>
          <td>
            ${escaparHtml(item.telefone || '-')}<br />
            <small>${escaparHtml(item.email || '-')}</small>
          </td>
          <td>
            <strong>${formatarData(item.proximo_vencimento)}</strong><br />
            <small>${formatarMoeda(item.valor_mensal)}</small>
          </td>
          <td>
            <span class="${classeStatus(item.status)}">${escaparHtml(String(item.status || '').toUpperCase())}</span>
          </td>
          <td>
            <strong>${escaparHtml(item.atraso?.indicador || 'Em dia')}</strong><br />
            <small>${escaparHtml(item.lembrete_pagamento?.mensagem || 'Pagamento em dia.')}</small>
          </td>
          <td>
            <input class="inline-input" data-field="ultimoPagamento" data-id="${item.id}" type="date" value="${item.ultimo_pagamento || ''}" />
          </td>
          <td>
            <input
              class="inline-input"
              data-field="observacoes"
              data-id="${item.id}"
              type="text"
              maxlength="180"
              value="${escaparHtml(item.observacoes || '')}"
              placeholder="Observacao interna"
            />
          </td>
          <td>
            <div class="action-stack">
              <button class="table-action" data-action="copiar-cobranca" data-id="${item.id}" type="button">Copiar mensagem</button>
              <a class="table-link-button" href="${item.cobranca?.lembreteLink || '#'}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
            </div>
          </td>
          <td>
            <div class="action-stack">
              <button class="table-action" data-action="confirmar" data-id="${item.id}" type="button">Confirmar pagamento</button>
              <button class="table-action danger-button" data-action="bloquear" data-id="${item.id}" type="button">Bloquear cliente</button>
              <button class="table-action" data-action="salvar" data-id="${item.id}" type="button">Salvar obs.</button>
            </div>
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

    assinaturasCache = assinaturas || [];
    suporteNumeroInput.value = config.suporteNumero || '';
    supportNumberLabel.textContent = `Suporte: ${config.suporteNumero || '--'}`;

    renderizarResumo(assinaturasCache, config);
    renderizarAssinaturas();
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
    await carregarPainelAdmin();
  } catch (error) {
    console.error(error);
    suporteMessage.textContent = 'Nao consegui atualizar o numero de suporte.';
  }
});

assinaturasTable.addEventListener('click', async (event) => {
  const botao = event.target.closest('button[data-action]');

  if (!botao) {
    return;
  }

  const { id, action } = botao.dataset;
  const ultimoPagamento = document.querySelector(`[data-field="ultimoPagamento"][data-id="${id}"]`)?.value;
  const observacoes = document.querySelector(`[data-field="observacoes"][data-id="${id}"]`)?.value?.trim() || '';
  const assinatura = assinaturasCache.find((item) => String(item.id) === String(id));

  try {
    botao.disabled = true;

    if (action === 'copiar-cobranca') {
      await navigator.clipboard.writeText(assinatura?.cobranca?.mensagem || '');
      suporteMessage.textContent = 'Mensagem de cobranca copiada.';
      return;
    }

    if (action === 'confirmar') {
      await buscarJson(`/api/admin/assinaturas/${id}/confirmar-pagamento`, {
        method: 'POST',
        body: JSON.stringify({ dataPagamento: ultimoPagamento, observacoes }),
      });
      suporteMessage.textContent = 'Pagamento confirmado manualmente.';
      await carregarPainelAdmin();
      return;
    }

    if (action === 'bloquear') {
      await buscarJson(`/api/admin/assinaturas/${id}/bloquear`, {
        method: 'POST',
        body: JSON.stringify({ observacoes }),
      });
      suporteMessage.textContent = 'Cliente bloqueado manualmente.';
      await carregarPainelAdmin();
      return;
    }

    if (action === 'salvar') {
      await buscarJson(`/api/admin/assinaturas/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: assinatura?.status || 'pendente',
          ultimoPagamento,
          observacoes,
        }),
      });
      suporteMessage.textContent = 'Observacao salva com sucesso.';
      await carregarPainelAdmin();
      return;
    }

    if (action === 'excluir') {
      if (!confirm('Tem certeza que deseja excluir este cliente? Esta acao nao pode ser desfeita.')) {
        return;
      }

      await buscarJson(`/api/admin/assinaturas/${id}`, {
        method: 'DELETE',
      });
      suporteMessage.textContent = 'Assinatura excluida com sucesso.';
      await carregarPainelAdmin();
    }
  } catch (error) {
    console.error(error);
    suporteMessage.textContent = error.message || 'Nao consegui concluir essa acao.';
  } finally {
    botao.disabled = false;
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
    cadastroLinkMessage.textContent = 'Nao consegui copiar automaticamente. O link ficou selecionado para copiar.';
  }
});

filtroButtons.forEach((button) => {
  button.addEventListener('click', () => {
    filtroStatusAtual = button.dataset.filtroStatus || 'todos';
    renderizarAssinaturas();
  });
});

carregarPainelAdmin();
