const express = require('express');
const path = require('path');
const crypto = require('crypto');

const asaas = require('./asaas');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const painelPath = path.join(__dirname, '..', 'painel');
const assinaturasCadastradas = [];
const barbeiroSessions = new Map();
const adminSessions = new Map();
const ADMIN_PIN = '5090';
let suporteNumeroAdmin = '--';
const ACESSO_VITALICIO = {
  id: 1,
  email: 'gabriel0009messias@gmail.com',
  senha: 'rios123456',
  barbeariaNome: 'Salão Demo',
  responsavelNome: 'Gabriel',
  telefone: '11999999999',
  status: 'ativo',
  whatsapp_status: 'nao_configurado',
  dias_funcionamento: [1, 2, 3, 4, 5, 6],
  horario_abertura: '08:00',
  horario_almoco_inicio: '12:00',
  horario_almoco_fim: '13:00',
  horario_fechamento: '18:00',
  servicos: [
    { id: 1, nome: 'Corte degrade', preco: 30 },
    { id: 2, nome: 'Luzes', preco: 80 },
  ],
};
const demoAgendamentos = [];
const demoBloqueios = [];

function montarProximaDataVencimento(dia) {
  const hoje = new Date();
  let ano = hoje.getFullYear();
  let mes = hoje.getMonth();

  if (hoje.getDate() > dia) {
    mes += 1;
  }

  if (mes > 11) {
    mes = 0;
    ano += 1;
  }

  return `${ano}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function formatarImagemPix(encodedImage = '') {
  if (!encodedImage) {
    return null;
  }

  return String(encodedImage).startsWith('data:')
    ? encodedImage
    : `data:image/png;base64,${encodedImage}`;
}

function apenasDigitos(valor = '') {
  return String(valor).replace(/\D/g, '');
}

function normalizarTelefoneAsaas(telefone = '') {
  const digitos = apenasDigitos(telefone);

  if (digitos.length === 13 && digitos.startsWith('55')) {
    return digitos.slice(2);
  }

  return digitos;
}

function montarCamposTelefone(telefone = '') {
  const telefoneNormalizado = normalizarTelefoneAsaas(telefone);

  if (telefoneNormalizado.length === 11) {
    return {
      mobilePhone: telefoneNormalizado,
    };
  }

  if (telefoneNormalizado.length === 10) {
    return {
      phone: telefoneNormalizado,
    };
  }

  return {
    mobilePhone: telefoneNormalizado,
  };
}

function extrairMensagemErro(error) {
  const lista = error?.response?.data?.errors;
  const mensagemOriginal =
    error?.response?.data?.error || error?.response?.data?.message || error.message || 'Erro ao processar requisicao.';

  if (Array.isArray(lista) && lista.length) {
    const mensagemLista = lista.map((item) => item.description || item.code).filter(Boolean).join(' | ');

    if (/nao permite pagamentos via pix/i.test(mensagemLista)) {
      return 'O Pix da sua conta Asaas nao esta habilitado para esta cobranca. Cadastre uma chave Pix e confira se a conta esta aprovada no Asaas.';
    }

    return mensagemLista;
  }

  if (/nao permite pagamentos via pix/i.test(mensagemOriginal)) {
    return 'O Pix da sua conta Asaas nao esta habilitado para esta cobranca. Cadastre uma chave Pix e confira se a conta esta aprovada no Asaas.';
  }

  return mensagemOriginal;
}

function precoDoServico(nomeServico = '') {
  const servico = ACESSO_VITALICIO.servicos.find(
    (item) => String(item.nome || '').trim().toLowerCase() === String(nomeServico || '').trim().toLowerCase()
  );

  return Number(servico?.preco || 0);
}

function encontrarServicoPorIdOuNome(servicoId, servicoNome) {
  const porId = Number(servicoId);

  if (Number.isInteger(porId) && porId > 0) {
    const encontradoPorId = ACESSO_VITALICIO.servicos.find((item) => Number(item.id) === porId);
    if (encontradoPorId) {
      return encontradoPorId;
    }
  }

  return ACESSO_VITALICIO.servicos.find(
    (item) => String(item.nome || '').trim().toLowerCase() === String(servicoNome || '').trim().toLowerCase()
  );
}

function filtrarAgendamentosConfirmados() {
  return demoAgendamentos.filter((item) => String(item.status || '').toLowerCase() === 'confirmado');
}

function somarPorPeriodo(periodo, referenciaMes = '') {
  const hoje = new Date();
  const hojeIso = hoje.toISOString().slice(0, 10);
  const mesAtual = hojeIso.slice(0, 7);
  const anoAtual = hojeIso.slice(0, 4);

  return filtrarAgendamentosConfirmados()
    .filter((item) => {
      const data = String(item.data || '');

      if (!data) {
        return false;
      }

      if (periodo === 'dia') {
        return data === hojeIso;
      }

      if (periodo === 'mes') {
        return data.slice(0, 7) === mesAtual;
      }

      if (periodo === 'ano') {
        return data.slice(0, 4) === anoAtual;
      }

      if (periodo === 'mes_customizado') {
        return referenciaMes && data.slice(0, 7) === referenciaMes;
      }

      return false;
    })
    .reduce((total, item) => total + precoDoServico(item.servico), 0);
}

async function criarClienteAsaasComFallback({ nome, cpfCnpj, email, telefone }) {
  const payloadBase = {
    name: nome,
    cpfCnpj,
    email,
  };

  try {
    return await asaas.post('/customers', {
      ...payloadBase,
      ...montarCamposTelefone(telefone),
    });
  } catch (error) {
    const lista = error?.response?.data?.errors || [];
    const erroTelefone = lista.some((item) => /invalid_phone|invalid_mobilePhone/i.test(String(item?.code || '')));

    if (!erroTelefone) {
      throw error;
    }

    return asaas.post('/customers', payloadBase);
  }
}

app.use(express.json());
app.use(express.static(painelPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(painelPath, 'index.html'));
});

app.get('/cadastro.html', (req, res) => {
  res.sendFile(path.join(painelPath, 'cadastro.html'));
});

app.get('/barbeiro.html', (req, res) => {
  res.sendFile(path.join(painelPath, 'barbeiro.html'));
});

app.get('/controle-interno', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Controle Interno | Salãoflix</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Segoe UI, Tahoma, Geneva, Verdana, sans-serif;
        color: #fff;
        background:
          linear-gradient(180deg, rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.85)),
          radial-gradient(circle at top right, rgba(229, 9, 20, 0.25), transparent 30%),
          radial-gradient(circle at bottom left, rgba(36, 36, 36, 0.4), transparent 30%),
          linear-gradient(120deg, #090909 0%, #1b1b1b 40%, #101010 100%);
      }
      .shell {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card, .panel {
        width: min(960px, 100%);
        border-radius: 24px;
        background: rgba(10, 10, 10, 0.88);
        border: 1px solid rgba(255,255,255,0.1);
        box-shadow: 0 24px 60px rgba(0,0,0,0.45);
      }
      .card {
        max-width: 520px;
        padding: 32px;
      }
      .panel {
        padding: 28px;
      }
      .eyebrow {
        margin: 0 0 10px;
        text-transform: uppercase;
        letter-spacing: .18em;
        font-size: .72rem;
        color: rgba(255,255,255,.65);
      }
      h1, h2, h3, p { margin-top: 0; }
      .help {
        margin: 16px 0 18px;
        padding: 16px 18px;
        border-radius: 18px;
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(229, 9, 20, .12);
      }
      .grid {
        display: grid;
        gap: 14px;
      }
      label {
        display: grid;
        gap: 8px;
        color: rgba(255,255,255,.82);
      }
      input, select, button {
        font: inherit;
      }
      input, select {
        width: 100%;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,.18);
        background: rgba(20,20,20,.92);
        color: #fff;
      }
      button {
        border: none;
        border-radius: 12px;
        padding: 16px 18px;
        cursor: pointer;
      }
      .primary {
        background: #e50914;
        color: #fff;
        font-weight: 700;
      }
      .secondary {
        background: rgba(255,255,255,.12);
        color: #fff;
        font-weight: 700;
      }
      .message {
        min-height: 24px;
        color: #7df0b1;
      }
      .error {
        color: #ffb3b6;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .summary {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin: 20px 0;
      }
      .pill {
        padding: 14px;
        border-radius: 16px;
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.08);
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 12px 10px;
        border-bottom: 1px solid rgba(255,255,255,.08);
        text-align: left;
      }
      th {
        color: rgba(255,255,255,.68);
        font-size: .82rem;
        text-transform: uppercase;
      }
      [hidden] {
        display: none !important;
      }
      @media (max-width: 720px) {
        .summary {
          grid-template-columns: 1fr 1fr;
        }
      }
      @media (max-width: 520px) {
        .summary {
          grid-template-columns: 1fr;
        }
        .card, .panel {
          padding: 16px;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section id="loginCard" class="card">
        <p class="eyebrow">Controle Interno</p>
        <h1>Painel administrativo</h1>
        <p>Entre com o PIN do admin para gerenciar assinaturas.</p>
        <div class="help">
          <strong>PIN atual para teste: 5090</strong>
          <p style="margin:8px 0 0">Se quiser, clique em Entrar rápido.</p>
        </div>
        <form id="loginForm" class="grid">
          <label>
            PIN do admin
            <input id="pinInput" type="password" value="5090" placeholder="Digite 5090" required />
          </label>
          <button class="primary" type="submit">Entrar</button>
          <button id="quickButton" class="secondary" type="button">Entrar rápido</button>
        </form>
        <p id="loginMessage" class="message"></p>
      </section>

      <section id="adminPanel" class="panel" hidden>
        <div class="topbar">
          <div>
            <p class="eyebrow">Admin</p>
            <h2>Assinaturas do sistema</h2>
            <p id="summaryText">Carregando...</p>
          </div>
          <div class="topbar">
            <button id="refreshButton" class="secondary" type="button">Recarregar</button>
            <button id="logoutButton" class="primary" type="button">Sair</button>
          </div>
        </div>

        <div id="summaryGrid" class="summary"></div>

        <div class="grid" style="margin: 18px 0 24px">
          <label>
            Número de suporte
            <input id="supportInput" type="text" />
          </label>
          <button id="saveSupportButton" class="secondary" type="button">Salvar suporte</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Salão</th>
                <th>Responsável</th>
                <th>Contato</th>
                <th>Pagamento</th>
                <th>Status</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody id="tableBody"></tbody>
          </table>
        </div>
        <p id="tableMessage" class="message"></p>
      </section>
    </main>

    <script>
      const tokenKey = 'admin_token_salaoflix_inline';
      const loginCard = document.getElementById('loginCard');
      const adminPanel = document.getElementById('adminPanel');
      const loginForm = document.getElementById('loginForm');
      const pinInput = document.getElementById('pinInput');
      const quickButton = document.getElementById('quickButton');
      const loginMessage = document.getElementById('loginMessage');
      const summaryText = document.getElementById('summaryText');
      const summaryGrid = document.getElementById('summaryGrid');
      const supportInput = document.getElementById('supportInput');
      const saveSupportButton = document.getElementById('saveSupportButton');
      const refreshButton = document.getElementById('refreshButton');
      const logoutButton = document.getElementById('logoutButton');
      const tableBody = document.getElementById('tableBody');
      const tableMessage = document.getElementById('tableMessage');

      function getToken() {
        return localStorage.getItem(tokenKey) || '';
      }

      function setToken(token) {
        localStorage.setItem(tokenKey, token);
      }

      function clearToken() {
        localStorage.removeItem(tokenKey);
      }

      async function api(url, options = {}) {
        const headers = new Headers(options.headers || {});
        const token = getToken();
        if (token) headers.set('x-admin-token', token);
        if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        const response = await fetch(url, { ...options, headers });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Falha no admin.');
        return data;
      }

      function resumoStatus(assinaturas) {
        const resumo = { total: assinaturas.length, ativo: 0, pendente: 0, bloqueado: 0 };
        for (const item of assinaturas) {
          const status = String(item.status || '').toLowerCase();
          if (status in resumo) resumo[status] += 1;
        }
        return resumo;
      }

      function renderSummary(assinaturas) {
        const resumo = resumoStatus(assinaturas);
        summaryText.textContent = resumo.total + ' assinaturas cadastradas no sistema.';
        summaryGrid.innerHTML = [
          ['Total', resumo.total],
          ['Ativos', resumo.ativo],
          ['Pendentes', resumo.pendente],
          ['Bloqueados', resumo.bloqueado],
        ].map(([label, value]) => '<div class="pill"><strong>' + label + ':</strong> ' + value + '</div>').join('');
      }

      function renderRows(assinaturas) {
        if (!assinaturas.length) {
          tableBody.innerHTML = '<tr><td colspan="6">Nenhuma assinatura cadastrada.</td></tr>';
          return;
        }

        tableBody.innerHTML = '';
        assinaturas.forEach((assinatura) => {
          const tr = document.createElement('tr');
          const contato = [assinatura.email, assinatura.telefone].filter(Boolean).join(' / ');
          const pagamento = (assinatura.metodo_pagamento || '--') + ' / dia ' + (assinatura.dia_vencimento || '--');

          tr.innerHTML = '<td>' + (assinatura.barbearia_nome || '--') + '</td>' +
            '<td>' + (assinatura.responsavel_nome || '--') + '</td>' +
            '<td>' + (contato || '--') + '</td>' +
            '<td>' + pagamento + '</td>' +
            '<td><select><option value="pendente">Pendente</option><option value="ativo">Ativo</option><option value="bloqueado">Bloqueado</option></select></td>' +
            '<td>' +
              '<div style="display:grid; gap:8px;">' +
                '<button class="secondary" type="button" data-action="save">Salvar</button>' +
                (assinatura.id !== 1
                  ? '<button class="primary" type="button" data-action="delete" style="background:#6e0b10;">Excluir</button>'
                  : '<button class="secondary" type="button" disabled title="Seu acesso principal nao pode ser excluido aqui">Acesso principal</button>') +
              '</div>' +
            '</td>';

          const select = tr.querySelector('select');
          select.value = assinatura.status || 'pendente';
          const saveButton = tr.querySelector('[data-action="save"]');
          const deleteButton = tr.querySelector('[data-action="delete"]');

          saveButton.addEventListener('click', async () => {
            tableMessage.textContent = 'Salvando status...';
            tableMessage.classList.remove('error');
            try {
              await api('/api/admin/assinaturas/' + assinatura.id, {
                method: 'PATCH',
                body: JSON.stringify({ status: select.value }),
              });
              tableMessage.textContent = 'Status atualizado com sucesso.';
              await loadPanel();
            } catch (error) {
              tableMessage.textContent = error.message;
              tableMessage.classList.add('error');
            }
          });

          if (deleteButton) {
            deleteButton.addEventListener('click', async () => {
              const confirmado = window.confirm('Deseja excluir essa pessoa da plataforma?');

              if (!confirmado) {
                return;
              }

              tableMessage.textContent = 'Excluindo assinatura...';
              tableMessage.classList.remove('error');

              try {
                await api('/api/admin/assinaturas/' + assinatura.id, {
                  method: 'DELETE',
                });
                tableMessage.textContent = 'Assinatura excluida com sucesso.';
                await loadPanel();
              } catch (error) {
                tableMessage.textContent = error.message;
                tableMessage.classList.add('error');
              }
            });
          }

          tableBody.appendChild(tr);
        });
      }

      async function loadPanel() {
        const [config, assinaturas] = await Promise.all([
          api('/api/admin/assinatura-config'),
          api('/api/admin/assinaturas'),
        ]);
        supportInput.value = config.suporteNumero || '--';
        renderSummary(assinaturas);
        renderRows(assinaturas);
      }

      async function enterAdmin(pin) {
        const payload = await api('/api/admin/login', {
          method: 'POST',
          body: JSON.stringify({ pin }),
        });
        setToken(payload.token);
        loginCard.hidden = true;
        adminPanel.hidden = false;
        await loadPanel();
      }

      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        loginMessage.textContent = 'Entrando...';
        loginMessage.classList.remove('error');
        try {
          await enterAdmin(pinInput.value.trim());
          loginMessage.textContent = '';
        } catch (error) {
          loginMessage.textContent = error.message;
          loginMessage.classList.add('error');
        }
      });

      quickButton.addEventListener('click', async () => {
        pinInput.value = '5090';
        loginMessage.textContent = 'Entrando...';
        loginMessage.classList.remove('error');
        try {
          await enterAdmin('5090');
          loginMessage.textContent = '';
        } catch (error) {
          loginMessage.textContent = error.message;
          loginMessage.classList.add('error');
        }
      });

      saveSupportButton.addEventListener('click', async () => {
        tableMessage.textContent = 'Salvando suporte...';
        tableMessage.classList.remove('error');
        try {
          await api('/api/admin/assinatura-config', {
            method: 'PATCH',
            body: JSON.stringify({ suporteNumero: supportInput.value.trim() }),
          });
          tableMessage.textContent = 'Suporte atualizado com sucesso.';
        } catch (error) {
          tableMessage.textContent = error.message;
          tableMessage.classList.add('error');
        }
      });

      refreshButton.addEventListener('click', async () => {
        tableMessage.textContent = 'Atualizando...';
        tableMessage.classList.remove('error');
        try {
          await loadPanel();
          tableMessage.textContent = 'Painel atualizado.';
        } catch (error) {
          tableMessage.textContent = error.message;
          tableMessage.classList.add('error');
        }
      });

      logoutButton.addEventListener('click', () => {
        clearToken();
        adminPanel.hidden = true;
        loginCard.hidden = false;
        loginMessage.textContent = '';
      });

      if (getToken()) {
        loginCard.hidden = true;
        adminPanel.hidden = false;
        loadPanel().catch((error) => {
          clearToken();
          adminPanel.hidden = true;
          loginCard.hidden = false;
          loginMessage.textContent = error.message;
          loginMessage.classList.add('error');
        });
      }
    </script>
  </body>
</html>`);
});

app.get('/controle-interno.html', (req, res) => {
  res.sendFile(path.join(painelPath, 'controle-interno.html'));
});

app.get('/api/publico/assinatura-config', (req, res) => {
  const emHospedagem = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
  const whatsappBridgeUrlPublic = String(
    process.env.WHATSAPP_BRIDGE_URL_PUBLIC || 'https://technician-elect-potential-wheel.trycloudflare.com'
  ).trim();
  const whatsappBridgeUrl = whatsappBridgeUrlPublic || (emHospedagem ? null : 'http://127.0.0.1:3010');

  res.json({
    suporteNumero: '--',
    valorMensal: 5,
    gateway: {
      provider: 'asaas',
      enabled: true,
      label: 'Asaas',
    },
    diasVencimento: [5, 20],
    metodosPagamento: ['cartao', 'pix'],
    funcionamentoPadrao: {
      diasFuncionamento: [1, 2, 3, 4, 5, 6],
      horarioAbertura: '08:00',
      horarioAlmocoInicio: '12:00',
      horarioAlmocoFim: '13:00',
      horarioFechamento: '18:00',
    },
    whatsappBridgeUrl,
    whatsappLocalOnly: !whatsappBridgeUrl,
  });
});

app.post('/criar-cliente', async (req, res) => {
  const { nome, cpf, email, telefone } = req.body;

  if (!nome || !cpf || !email || !telefone) {
    res.status(400).json({
      error: 'Informe nome, cpf, email e telefone',
    });
    return;
  }

  try {
    const response = await criarClienteAsaasComFallback({
      nome,
      cpfCnpj: apenasDigitos(cpf),
      email,
      telefone,
    });

    res.status(201).json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: extrairMensagemErro(error),
      details: error.response?.data || null,
    });
  }
});

function obterSessaoBarbeiro(req) {
  const token = String(req.headers['x-barbeiro-token'] || '').trim();

  if (!token || !barbeiroSessions.has(token)) {
    return null;
  }

  return barbeiroSessions.get(token);
}

function requireBarbeiro(req, res, next) {
  const sessao = obterSessaoBarbeiro(req);

  if (!sessao) {
    res.status(401).json({ error: 'Login obrigatorio.' });
    return;
  }

  req.sessaoBarbeiro = sessao;
  next();
}

function obterTokenBridgeWhatsapp(req) {
  return String(req.headers['x-whatsapp-bridge-token'] || '').trim();
}

function requireBarbeiroOuBridge(req, res, next) {
  const sessao = obterSessaoBarbeiro(req);

  if (sessao) {
    req.sessaoBarbeiro = sessao;
    req.autenticadoViaBridge = false;
    next();
    return;
  }

  const bridgeToken = obterTokenBridgeWhatsapp(req);

  if (bridgeToken && bridgeToken === 'demo-bridge-token') {
    req.autenticadoViaBridge = true;
    next();
    return;
  }

  res.status(401).json({ error: 'Login obrigatorio.' });
}

function obterTokenAdmin(req) {
  return String(req.headers['x-admin-token'] || '').trim();
}

function requireAdmin(req, res, next) {
  const token = obterTokenAdmin(req);

  if (!token || !adminSessions.has(token)) {
    res.status(401).json({ error: 'Acesso admin nao autorizado.' });
    return;
  }

  req.adminToken = token;
  next();
}

function listarAssinaturasAdmin() {
  const acessoVitalicio = {
    id: ACESSO_VITALICIO.id,
    barbearia_nome: ACESSO_VITALICIO.barbeariaNome,
    responsavel_nome: ACESSO_VITALICIO.responsavelNome,
    telefone: ACESSO_VITALICIO.telefone,
    email: ACESSO_VITALICIO.email,
    metodo_pagamento: 'acesso_liberado',
    dia_vencimento: '-',
    status: ACESSO_VITALICIO.status,
  };

  const cadastradas = assinaturasCadastradas.map((assinatura) => ({
    id: assinatura.id,
    barbearia_nome: assinatura.barbeariaNome,
    responsavel_nome: assinatura.responsavelNome,
    telefone: assinatura.telefone,
    email: assinatura.email,
    metodo_pagamento: assinatura.metodoPagamento,
    dia_vencimento: assinatura.diaVencimento,
    status: assinatura.status,
  }));

  return [acessoVitalicio, ...cadastradas];
}

app.post('/api/barbeiro/login', (req, res) => {
  const identificador = String(req.body?.identificador || '').trim().toLowerCase();
  const senha = String(req.body?.senha || '');

  if (identificador !== ACESSO_VITALICIO.email || senha !== ACESSO_VITALICIO.senha) {
    res.status(401).json({ error: 'Gmail ou senha invalidos.' });
    return;
  }

  const token = crypto.randomBytes(24).toString('hex');
  barbeiroSessions.set(token, {
    assinaturaId: ACESSO_VITALICIO.id,
    email: ACESSO_VITALICIO.email,
    tipo: 'acesso_vitalicio',
  });

  res.json({
    token,
    assinatura: {
      id: ACESSO_VITALICIO.id,
      email: ACESSO_VITALICIO.email,
      status: ACESSO_VITALICIO.status,
    },
  });
});

app.post('/api/admin/login', (req, res) => {
  const pin = String(req.body?.pin || '').trim();

  if (pin !== ADMIN_PIN) {
    res.status(401).json({ error: 'PIN admin invalido.' });
    return;
  }

  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, { createdAt: Date.now() });
  res.json({ token, expiresInHours: 12 });
});

app.get('/api/admin/assinatura-config', requireAdmin, (req, res) => {
  res.json({
    suporteNumero: suporteNumeroAdmin,
    valorMensal: 5,
    gateway: {
      provider: 'asaas',
      enabled: true,
      label: 'Asaas',
    },
    diasVencimento: [5, 20],
    metodosPagamento: ['cartao', 'pix'],
    statusDisponiveis: ['pendente', 'ativo', 'bloqueado'],
  });
});

app.patch('/api/admin/assinatura-config', requireAdmin, (req, res) => {
  const suporteNumero = String(req.body?.suporteNumero || '').trim();

  if (!suporteNumero) {
    res.status(400).json({ error: 'Numero de suporte e obrigatorio.' });
    return;
  }

  suporteNumeroAdmin = suporteNumero;
  res.json({ suporteNumero: suporteNumeroAdmin });
});

app.get('/api/admin/assinaturas', requireAdmin, (req, res) => {
  res.json(listarAssinaturasAdmin());
});

app.patch('/api/admin/assinaturas/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '').trim().toLowerCase();

  if (!['pendente', 'ativo', 'bloqueado'].includes(status)) {
    res.status(400).json({ error: 'Status invalido.' });
    return;
  }

  if (id === ACESSO_VITALICIO.id) {
    ACESSO_VITALICIO.status = status;
    res.json({
      id: ACESSO_VITALICIO.id,
      status: ACESSO_VITALICIO.status,
    });
    return;
  }

  const assinatura = assinaturasCadastradas.find((item) => item.id === id);

  if (!assinatura) {
    res.status(404).json({ error: 'Assinatura nao encontrada.' });
    return;
  }

  assinatura.status = status;
  res.json({
    id: assinatura.id,
    status: assinatura.status,
  });
});

app.delete('/api/admin/assinaturas/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  if (id === ACESSO_VITALICIO.id) {
    res.status(400).json({ error: 'O acesso vitalicio principal nao pode ser excluido por aqui.' });
    return;
  }

  const index = assinaturasCadastradas.findIndex((item) => item.id === id);

  if (index === -1) {
    res.status(404).json({ error: 'Assinatura nao encontrada.' });
    return;
  }

  const [removida] = assinaturasCadastradas.splice(index, 1);

  res.json({
    ok: true,
    removida: {
      id: removida.id,
      barbearia_nome: removida.barbeariaNome,
      email: removida.email,
    },
  });
});

app.get('/api/barbeiro/me', (req, res) => {
  const sessao = obterSessaoBarbeiro(req);

  if (!sessao) {
    res.status(401).json({ error: 'Login obrigatorio.' });
    return;
  }

  res.json({
    id: ACESSO_VITALICIO.id,
    email: ACESSO_VITALICIO.email,
    barbearia_nome: ACESSO_VITALICIO.barbeariaNome,
    responsavel_nome: ACESSO_VITALICIO.responsavelNome,
    telefone: ACESSO_VITALICIO.telefone,
    status: ACESSO_VITALICIO.status,
    whatsapp_status: ACESSO_VITALICIO.whatsapp_status,
    dias_funcionamento: ACESSO_VITALICIO.dias_funcionamento,
    horario_abertura: ACESSO_VITALICIO.horario_abertura,
    horario_almoco_inicio: ACESSO_VITALICIO.horario_almoco_inicio,
    horario_almoco_fim: ACESSO_VITALICIO.horario_almoco_fim,
    horario_fechamento: ACESSO_VITALICIO.horario_fechamento,
    servicos: ACESSO_VITALICIO.servicos,
  });
});

app.get('/api/agendamentos', requireBarbeiroOuBridge, (req, res) => {
  res.json(demoAgendamentos);
});

app.get('/api/faturamento', requireBarbeiro, (req, res) => {
  const periodo = String(req.query?.periodo || 'mes').trim().toLowerCase();
  const mes = String(req.query?.mes || '').trim();

  if (periodo === 'mes_customizado') {
    if (!/^\d{4}-\d{2}$/.test(mes)) {
      res.status(400).json({ error: 'Informe o mes no formato YYYY-MM.' });
      return;
    }

    res.json({ total: somarPorPeriodo('mes_customizado', mes), referencia: mes });
    return;
  }

  res.json({ total: somarPorPeriodo(periodo) });
});

app.get('/api/bloqueios', requireBarbeiroOuBridge, (req, res) => {
  res.json(demoBloqueios);
});

app.post('/api/bloqueios', requireBarbeiro, (req, res) => {
  const { data, hora } = req.body;

  if (!data || !hora) {
    res.status(400).json({ error: 'Informe data e hora.' });
    return;
  }

  const bloqueio = {
    id: Date.now(),
    data,
    hora,
  };

  demoBloqueios.push(bloqueio);
  res.status(201).json(bloqueio);
});

app.delete('/api/agendamentos/:id', requireBarbeiro, (req, res) => {
  const id = Number(req.params.id);
  const index = demoAgendamentos.findIndex((item) => item.id === id);

  if (index >= 0) {
    demoAgendamentos.splice(index, 1);
  }

  res.json({ success: true });
});

app.get('/api/publico/assinaturas/:id', requireBarbeiroOuBridge, (req, res) => {
  res.json({
    id: ACESSO_VITALICIO.id,
    dias_funcionamento: ACESSO_VITALICIO.dias_funcionamento,
    horario_abertura: ACESSO_VITALICIO.horario_abertura,
    horario_almoco_inicio: ACESSO_VITALICIO.horario_almoco_inicio,
    horario_almoco_fim: ACESSO_VITALICIO.horario_almoco_fim,
    horario_fechamento: ACESSO_VITALICIO.horario_fechamento,
    whatsapp_status: ACESSO_VITALICIO.whatsapp_status,
    servicos: ACESSO_VITALICIO.servicos,
  });
});

app.get('/api/publico/assinaturas/:id/acesso', (req, res) => {
  const id = Number(req.params.id);

  if (id === ACESSO_VITALICIO.id) {
    res.json({
      liberado: ACESSO_VITALICIO.status === 'ativo',
      mensagem:
        ACESSO_VITALICIO.status === 'ativo'
          ? ''
          : 'Atendimento temporariamente bloqueado. Regularize a assinatura para voltar a agendar.',
    });
    return;
  }

  const assinatura = assinaturasCadastradas.find((item) => item.id === id);

  if (!assinatura) {
    res.status(404).json({
      liberado: false,
      mensagem: 'Essa assinatura nao foi encontrada. Entre em contato com o suporte.',
    });
    return;
  }

  res.json({
    liberado: assinatura.status === 'ativo',
    mensagem:
      assinatura.status === 'ativo'
        ? ''
        : 'Atendimento temporariamente bloqueado. Regularize a assinatura para voltar a agendar.',
  });
});

app.patch('/api/publico/assinaturas/:id', requireBarbeiro, (req, res) => {
  const {
    diasFuncionamento,
    horarioAbertura,
    horarioAlmocoInicio,
    horarioAlmocoFim,
    horarioFechamento,
    servicos,
  } = req.body;

  ACESSO_VITALICIO.dias_funcionamento = Array.isArray(diasFuncionamento)
    ? diasFuncionamento
    : ACESSO_VITALICIO.dias_funcionamento;
  ACESSO_VITALICIO.horario_abertura = horarioAbertura || ACESSO_VITALICIO.horario_abertura;
  ACESSO_VITALICIO.horario_almoco_inicio = horarioAlmocoInicio || ACESSO_VITALICIO.horario_almoco_inicio;
  ACESSO_VITALICIO.horario_almoco_fim = horarioAlmocoFim || ACESSO_VITALICIO.horario_almoco_fim;
  ACESSO_VITALICIO.horario_fechamento = horarioFechamento || ACESSO_VITALICIO.horario_fechamento;

  if (Array.isArray(servicos) && servicos.length) {
    ACESSO_VITALICIO.servicos = servicos.map((item, index) => ({
      id: index + 1,
      nome: item.nome,
      preco: Number(item.preco),
    }));
  }

  res.json({
    id: ACESSO_VITALICIO.id,
    dias_funcionamento: ACESSO_VITALICIO.dias_funcionamento,
    horario_abertura: ACESSO_VITALICIO.horario_abertura,
    horario_almoco_inicio: ACESSO_VITALICIO.horario_almoco_inicio,
    horario_almoco_fim: ACESSO_VITALICIO.horario_almoco_fim,
    horario_fechamento: ACESSO_VITALICIO.horario_fechamento,
    servicos: ACESSO_VITALICIO.servicos,
  });
});

app.post('/api/agendamentos', requireBarbeiroOuBridge, (req, res) => {
  const { cliente, telefone, servicoId, servicoNome, data, hora } = req.body;

  if (!cliente || !telefone || !data || !hora) {
    res.status(400).json({ error: 'Informe cliente, telefone, data e hora.' });
    return;
  }

  const servico = encontrarServicoPorIdOuNome(servicoId, servicoNome);

  if (!servico) {
    res.status(400).json({ error: 'Servico nao encontrado para este agendamento.' });
    return;
  }

  const conflito = demoAgendamentos.some(
    (item) => item.data === data && item.hora === hora && String(item.status || '').toLowerCase() === 'confirmado'
  );

  if (conflito) {
    res.status(409).json({ error: 'Esse horario acabou de ser reservado por outro cliente.' });
    return;
  }

  const agendamento = {
    id: Date.now(),
    cliente,
    telefone,
    servico: servico.nome,
    servico_id: servico.id,
    servico_preco: Number(servico.preco || 0),
    data,
    hora,
    status: 'confirmado',
    lembrete_15_enviado_em: null,
    lembrete_7_enviado_em: null,
  };

  demoAgendamentos.push(agendamento);
  res.status(201).json(agendamento);
});

app.post('/api/publico/assinaturas/:id/whatsapp/bridge-token', requireBarbeiro, (req, res) => {
  res.json({ token: 'demo-bridge-token' });
});

app.post('/api/agendamentos/:id/lembrete-15', (req, res) => {
  const id = Number(req.params.id);
  const agendamento = demoAgendamentos.find((item) => item.id === id);

  if (!agendamento) {
    res.status(404).json({ error: 'Agendamento nao encontrado.' });
    return;
  }

  agendamento.lembrete_15_enviado_em = req.body?.enviadoEm || new Date().toISOString();
  res.json({ ok: true });
});

app.post('/api/agendamentos/:id/lembrete-7', (req, res) => {
  const id = Number(req.params.id);
  const agendamento = demoAgendamentos.find((item) => item.id === id);

  if (!agendamento) {
    res.status(404).json({ error: 'Agendamento nao encontrado.' });
    return;
  }

  agendamento.lembrete_7_enviado_em = req.body?.enviadoEm || new Date().toISOString();
  res.json({ ok: true });
});

app.post('/api/barbeiro/logout', (req, res) => {
  const token = String(req.headers['x-barbeiro-token'] || '').trim();

  if (token) {
    barbeiroSessions.delete(token);
  }

  res.json({ ok: true });
});

app.post('/api/publico/assinaturas', async (req, res) => {
  const {
    barbeariaNome,
    responsavelNome,
    telefone,
    email,
    cpfTitular,
    metodoPagamento,
    diaVencimento,
    creditCard,
    creditCardHolderInfo,
  } = req.body;

  if (!barbeariaNome || !responsavelNome || !telefone || !email || !metodoPagamento || !diaVencimento) {
    res.status(400).json({ error: 'Preencha os campos obrigatorios do cadastro.' });
    return;
  }

  if (metodoPagamento === 'cartao') {
    const dadosCartaoValidos =
      creditCard?.holderName &&
      creditCard?.number &&
      creditCard?.expiryMonth &&
      creditCard?.expiryYear &&
      creditCard?.ccv;

    const dadosTitularValidos =
      creditCardHolderInfo?.name &&
      creditCardHolderInfo?.email &&
      (creditCardHolderInfo?.cpfCnpj || cpfTitular) &&
      creditCardHolderInfo?.postalCode &&
      creditCardHolderInfo?.addressNumber;

    if (!dadosCartaoValidos || !dadosTitularValidos) {
      res.status(400).json({ error: 'Preencha os dados do cartao e do titular para continuar.' });
      return;
    }
  }

  try {
    const clienteResponse = await criarClienteAsaasComFallback({
      nome: responsavelNome,
      cpfCnpj: cpfTitular || '00000000000',
      email,
      telefone,
    });

    const customerId = clienteResponse.data.id;
    const dia = Number(diaVencimento);
    const nextDueDate = montarProximaDataVencimento(dia);

    const billingType = metodoPagamento === 'cartao' ? 'CREDIT_CARD' : 'PIX';
    let assinaturaResponse = null;
    let pixQrCode = null;
    let payment = null;

    if (billingType === 'CREDIT_CARD') {
      const payloadAssinatura = {
        customer: customerId,
        billingType,
        value: 5,
        cycle: 'MONTHLY',
        nextDueDate,
        creditCard,
        creditCardHolderInfo: {
          ...creditCardHolderInfo,
          cpfCnpj: creditCardHolderInfo?.cpfCnpj || cpfTitular,
        },
        remoteIp: req.ip || req.socket?.remoteAddress || '127.0.0.1',
      };

      assinaturaResponse = await asaas.post('/subscriptions', payloadAssinatura);
    } else {
      const paymentResponse = await asaas.post('/payments', {
        customer: customerId,
        billingType: 'PIX',
        value: 5,
        dueDate: nextDueDate,
        description: `Assinatura Salãoflix - ${barbeariaNome}`,
      });

      payment = paymentResponse.data;

      const pixResponse = await asaas.get(`/payments/${payment.id}/pixQrCode`);
      pixQrCode = {
        ...pixResponse.data,
        imageUrl: formatarImagemPix(pixResponse.data?.encodedImage),
      };
    }

    const assinatura = {
      id: Date.now(),
      barbeariaNome,
      responsavelNome,
      telefone,
      email,
      metodoPagamento,
      diaVencimento: dia,
      status: 'pendente',
      whatsapp_status: 'nao_configurado',
      asaasCustomerId: customerId,
      asaasSubscriptionId: assinaturaResponse?.data?.id || null,
      asaasPaymentId: payment?.id || null,
    };

    assinaturasCadastradas.push(assinatura);

    res.status(201).json({
      mensagem:
        billingType === 'PIX'
          ? 'Cadastro concluido. Mostre o QR Code Pix para o cliente concluir o pagamento.'
          : 'Cadastro concluido. Assinatura criada com sucesso.',
      checkoutUrl: assinaturaResponse?.data?.invoiceUrl || null,
      assinatura,
      customer: clienteResponse.data,
      subscription: assinaturaResponse?.data || null,
      payment,
      pixQrCode,
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: extrairMensagemErro(error),
      details: error.response?.data || null,
    });
  }
});

app.post('/criar-assinatura', async (req, res) => {
  const { customerId, diaVencimento, metodoPagamento, creditCard, creditCardHolderInfo } = req.body;
  const dia = Number(diaVencimento);

  if (!customerId) {
    res.status(400).json({
      error: 'Informe customerId',
    });
    return;
  }

  if (![5, 20].includes(dia)) {
    res.status(400).json({
      error: 'Informe diaVencimento igual a 5 ou 20',
    });
    return;
  }

  const nextDueDate = montarProximaDataVencimento(dia);

  try {
    const billingType = metodoPagamento === 'pix' ? 'PIX' : 'CREDIT_CARD';
    if (billingType === 'PIX') {
      const paymentResponse = await asaas.post('/payments', {
        customer: customerId,
        billingType: 'PIX',
        value: 5,
        dueDate: nextDueDate,
      });

      const pixResponse = await asaas.get(`/payments/${paymentResponse.data.id}/pixQrCode`);

      res.status(201).json({
        payment: paymentResponse.data,
        pixQrCode: {
          ...pixResponse.data,
          imageUrl: formatarImagemPix(pixResponse.data?.encodedImage),
        },
      });
      return;
    }

    const response = await asaas.post('/subscriptions', {
      customer: customerId,
      billingType,
      value: 5,
      cycle: 'MONTHLY',
      nextDueDate,
      creditCard,
      creditCardHolderInfo,
      remoteIp: req.ip || req.socket?.remoteAddress || '127.0.0.1',
    });

    res.status(201).json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: extrairMensagemErro(error),
      details: error.response?.data || null,
    });
  }
});

app.post('/webhook', (req, res) => {
  const { event } = req.body;

  if (event === 'PAYMENT_RECEIVED') {
    console.log('pagou');
  }

  if (event === 'PAYMENT_OVERDUE') {
    console.log('atrasado');
  }

  res.json({ received: true });
});

app.use((err, req, res, next) => {
  console.error('Erro no servidor:', err);

  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    res.status(400).json({ error: 'JSON invalido na requisicao.' });
    return;
  }

  res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor.',
  });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
