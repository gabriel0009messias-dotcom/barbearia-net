const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const DIAS_SEMANA = [
  { value: 0, label: 'Dom' },
  { value: 1, label: 'Seg' },
  { value: 2, label: 'Ter' },
  { value: 3, label: 'Qua' },
  { value: 4, label: 'Qui' },
  { value: 5, label: 'Sex' },
  { value: 6, label: 'Sab' },
];

const TOKEN_STORAGE_KEY = 'barbearia_auth_token';

const agendamentosTable = document.getElementById('agendamentosTable');
const agendamentoCount = document.getElementById('agendamentoCount');
const agendamentosTableInicio = document.getElementById('agendamentosTableInicio');
const agendamentoCountInicio = document.getElementById('agendamentoCountInicio');
const faturamentoDia = document.getElementById('faturamentoDia');
const faturamentoMes = document.getElementById('faturamentoMes');
const faturamentoAno = document.getElementById('faturamentoAno');
const faturamentoMesEscolhido = document.getElementById('faturamentoMesEscolhido');
const mesFaturamentoInput = document.getElementById('mesFaturamentoInput');
const mesFaturamentoResultado = document.getElementById('mesFaturamentoResultado');
const mesFaturamentoMensagem = document.getElementById('mesFaturamentoMensagem');
const bloqueiosList = document.getElementById('bloqueiosList');
const formMessage = document.getElementById('formMessage');
const bloqueiosListInicio = document.getElementById('bloqueiosListInicio');
const formMessageInicio = document.getElementById('formMessageInicio');
const refreshButton = document.getElementById('refreshButton');
const logoutBarbeiroButton = document.getElementById('logoutBarbeiroButton');
const topbarActionMessage = document.getElementById('topbarActionMessage');
const bloqueioForm = document.getElementById('bloqueioForm');
const bloqueioFormInicio = document.getElementById('bloqueioFormInicio');
const supportNumberLabel = document.getElementById('supportNumberLabel');
const menuButtons = Array.from(document.querySelectorAll('[data-section-target]'));
const panelViews = Array.from(document.querySelectorAll('.panel-view'));
const generateQrButton = document.getElementById('generateQrButton');
const openLocalWhatsappButton = document.getElementById('openLocalWhatsappButton');
const qrCodeImage = document.getElementById('qrCodeImage');
const qrStatusMessage = document.getElementById('qrStatusMessage');
const whatsappStatusBadge = document.getElementById('whatsappStatusBadge');
const whatsappHelpText = document.getElementById('whatsappHelpText');
const painelLiberadoMessage = document.getElementById('painelLiberadoMessage');
const paymentReminderCard = document.getElementById('paymentReminderCard');
const paymentReminderText = document.getElementById('paymentReminderText');
const paymentPixValor = document.getElementById('paymentPixValor');
const paymentPixCopiaCola = document.getElementById('paymentPixCopiaCola');
const paymentPixInstruction = document.getElementById('paymentPixInstruction');
const paymentWhatsappButton = document.getElementById('paymentWhatsappButton');
const paymentPixQrImage = document.getElementById('paymentPixQrImage');
const copyPixButton = document.getElementById('copyPixButton');
const painelBloqueadoMessage = document.getElementById('painelBloqueadoMessage');
const blockedMessageText = document.getElementById('blockedMessageText');
const blockedPixCard = document.getElementById('blockedPixCard');
const blockedPixValorLabel = document.getElementById('blockedPixValorLabel');
const blockedPixFavorecidoLabel = document.getElementById('blockedPixFavorecidoLabel');
const blockedPixQrPanel = document.getElementById('blockedPixQrPanel');
const blockedPixQrImage = document.getElementById('blockedPixQrImage');
const blockedPixChaveLabel = document.getElementById('blockedPixChaveLabel');
const blockedPixCopiaColaLabel = document.getElementById('blockedPixCopiaColaLabel');
const blockedWhatsappButton = document.getElementById('blockedWhatsappButton');
const configuracoesBarbeiroForm = document.getElementById('configuracoesBarbeiroForm');
const configuracoesMessage = document.getElementById('configuracoesMessage');
const diasFuncionamentoPainel = document.getElementById('diasFuncionamentoPainel');
const painelHorarioAberturaInput = document.getElementById('painelHorarioAberturaInput');
const painelHorarioAlmocoInicioInput = document.getElementById('painelHorarioAlmocoInicioInput');
const painelHorarioAlmocoFimInput = document.getElementById('painelHorarioAlmocoFimInput');
const painelHorarioFechamentoInput = document.getElementById('painelHorarioFechamentoInput');
const painelLocalizacaoCidadeInput = document.getElementById('painelLocalizacaoCidadeInput');
const painelLocalizacaoRuaInput = document.getElementById('painelLocalizacaoRuaInput');
const painelLocalizacaoReferenciaInput = document.getElementById('painelLocalizacaoReferenciaInput');
const addPainelServiceButton = document.getElementById('addPainelServiceButton');
const savePainelServicesButton = document.getElementById('savePainelServicesButton');
const painelServiceRows = document.getElementById('painelServiceRows');
const precosAtuaisGrid = document.getElementById('precosAtuaisGrid');
const servicesMessage = document.getElementById('servicesMessage');

let assinaturaAtualId = null;
let authToken = localStorage.getItem(TOKEN_STORAGE_KEY) || null;
let whatsappPolling = null;
let pixConfig = null;
let valorMensalAtual = 1;
let whatsappEnabled = false;
let activeSectionId = 'inicio';
let qrRequestInFlight = false;
let ultimoQrGeradoEm = 0;
let ultimoStatusWhatsapp = 'nao_configurado';
let painelAutoRefresh = null;

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

function getHeaders(extra = {}) {
  const headers = { ...extra };

  if (authToken) {
    headers['x-barbeiro-token'] = authToken;
  }

  return headers;
}

async function buscarJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: getHeaders(options.headers || {}),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const erro = new Error(payload?.error || `Falha ao carregar ${url}`);
    erro.status = response.status;
    erro.details = payload;
    throw erro;
  }

  return payload;
}

function limparSessaoBarbeiro() {
  authToken = null;
  assinaturaAtualId = null;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function mostrarMensagemTopo(mensagem = '') {
  if (topbarActionMessage) {
    topbarActionMessage.textContent = mensagem;
  }
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderizarDiasFuncionamento(container, selecionados = [1, 2, 3, 4, 5, 6]) {
  container.innerHTML = DIAS_SEMANA.map(
    (dia) => `
      <label class="day-pill">
        <input type="checkbox" value="${dia.value}" ${selecionados.includes(dia.value) ? 'checked' : ''} />
        <span>${dia.label}</span>
      </label>
    `
  ).join('');
}

function coletarDiasSelecionados(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map((input) => Number(input.value));
}

function criarLinhaServico(container, nome = '', preco = '') {
  const row = document.createElement('div');
  row.className = 'service-row';
  row.innerHTML = `
    <input class="service-name-input" type="text" placeholder="Ex.: Corte degrade" value="${escaparHtml(nome)}" />
    <input class="service-price-input" type="number" min="1" step="0.01" placeholder="Preco" value="${escaparHtml(preco)}" />
    <button type="button" class="table-action danger-button" data-remove-service>Remover</button>
  `;

  container.appendChild(row);
}

function coletarServicos(container) {
  return Array.from(container.querySelectorAll('.service-row'))
    .map((row) => ({
      nome: row.querySelector('.service-name-input')?.value.trim(),
      preco: row.querySelector('.service-price-input')?.value,
    }))
    .filter((item) => item.nome && Number(item.preco) > 0);
}

function setActiveSection(sectionId) {
  activeSectionId = sectionId;

  panelViews.forEach((view) => {
    const isActive = view.dataset.section === sectionId;
    view.hidden = !isActive;
    view.classList.toggle('is-active', isActive);
  });

  menuButtons.forEach((button) => {
    const isActive = button.dataset.sectionTarget === sectionId;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}

function renderizarPrecosAtuais(servicos = []) {
  if (!precosAtuaisGrid) {
    return;
  }

  if (!servicos.length) {
    precosAtuaisGrid.innerHTML = `
      <article class="price-card">
        <strong>Nenhum servico cadastrado.</strong>
        <p>Cadastre um servico na aba Servicos para ver os precos aqui.</p>
      </article>
    `;
    return;
  }

  precosAtuaisGrid.innerHTML = servicos
    .map(
      (servico) => `
        <article class="price-card">
          <span>${escaparHtml(servico.nome || 'Servico')}</span>
          <strong>${currency.format(Number(servico.preco || 0))}</strong>
          <p>Preco atual publicado no painel.</p>
        </article>
      `
    )
    .join('');
}

function preencherConfiguracoesPainel(assinatura) {
  renderizarDiasFuncionamento(diasFuncionamentoPainel, assinatura.dias_funcionamento || [1, 2, 3, 4, 5, 6]);
  painelHorarioAberturaInput.value = assinatura.horario_abertura || '08:00';
  painelHorarioAlmocoInicioInput.value = assinatura.horario_almoco_inicio || '12:00';
  painelHorarioAlmocoFimInput.value = assinatura.horario_almoco_fim || '13:00';
  painelHorarioFechamentoInput.value = assinatura.horario_fechamento || '18:00';
  if (painelLocalizacaoCidadeInput) {
    painelLocalizacaoCidadeInput.value = assinatura.localizacao_cidade || '';
  }
  if (painelLocalizacaoRuaInput) {
    painelLocalizacaoRuaInput.value = assinatura.localizacao_rua || '';
  }
  if (painelLocalizacaoReferenciaInput) {
    painelLocalizacaoReferenciaInput.value = assinatura.localizacao_referencia || '';
  }
  painelServiceRows.innerHTML = '';

  (assinatura.servicos || []).forEach((servico) => {
    criarLinhaServico(painelServiceRows, servico.nome, servico.preco);
  });

  if (!painelServiceRows.children.length) {
    criarLinhaServico(painelServiceRows, 'Corte degrade', '30');
  }

  renderizarPrecosAtuais(assinatura.servicos || []);
}

function renderizarAgendamentos(agendamentos) {
  const htmlSemItens = '<tr><td colspan="7">Nenhum agendamento encontrado.</td></tr>';
  const html = !agendamentos.length
    ? htmlSemItens
    : agendamentos
        .map(
          (item) => `
            <tr>
              <td>${escaparHtml(item.cliente || item.telefone || 'Sem nome')}</td>
              <td>${escaparHtml(item.servico || '-')}</td>
              <td>${currency.format(Number(item.preco || 0))}</td>
              <td>${formatarData(item.data)}</td>
              <td>${escaparHtml(item.hora || '-')}</td>
              <td>${escaparHtml(item.status || '-')}</td>
              <td>
                <button class="table-action danger-button" data-id="${item.id}" type="button">Excluir</button>
              </td>
            </tr>
          `
        )
        .join('');

  if (agendamentoCount) {
    agendamentoCount.textContent = `${agendamentos.length} itens`;
  }
  if (agendamentoCountInicio) {
    agendamentoCountInicio.textContent = `${agendamentos.length} itens`;
  }
  if (agendamentosTable) {
    agendamentosTable.innerHTML = html;
  }
  if (agendamentosTableInicio) {
    agendamentosTableInicio.innerHTML = html;
  }
}

function renderizarFaturamento([dia, mes, ano]) {
  faturamentoDia.textContent = currency.format(Number(dia.total || 0));
  faturamentoMes.textContent = currency.format(Number(mes.total || 0));
  faturamentoAno.textContent = currency.format(Number(ano.total || 0));
}

async function carregarFaturamentoMesEscolhido() {
  const referencia = mesFaturamentoInput?.value;

  if (!referencia) {
    mesFaturamentoResultado.value = currency.format(0);
    faturamentoMesEscolhido.textContent = currency.format(0);
    mesFaturamentoMensagem.textContent = 'Escolha um mes para consultar o faturamento.';
    return;
  }

  try {
    const resultado = await buscarJson(`/api/faturamento?periodo=mes_customizado&mes=${encodeURIComponent(referencia)}`);
    const total = Number(resultado.total || 0);
    mesFaturamentoResultado.value = currency.format(total);
    faturamentoMesEscolhido.textContent = currency.format(total);
    mesFaturamentoMensagem.textContent = `Faturamento de ${referencia}: ${currency.format(total)}`;
  } catch (error) {
    console.error(error);
    mesFaturamentoMensagem.textContent = error.message || 'Nao consegui carregar o faturamento do mes.';
  }
}

function renderizarBloqueios(bloqueios) {
  if (!bloqueios.length) {
    if (bloqueiosList) {
      bloqueiosList.innerHTML = '<li>Nenhum bloqueio cadastrado.</li>';
    }
    if (bloqueiosListInicio) {
      bloqueiosListInicio.innerHTML = '<li>Nenhum bloqueio cadastrado.</li>';
    }
    return;
  }

  const html = bloqueios
    .map(
      (item) => `
        <li class="list-row">
          <span>${formatarData(item.data)} as ${escaparHtml(item.hora)}</span>
          <button class="table-action danger-button" data-bloqueio-id="${item.id}" type="button">Excluir</button>
        </li>
      `
    )
    .join('');
  if (bloqueiosList) {
    bloqueiosList.innerHTML = html;
  }
  if (bloqueiosListInicio) {
    bloqueiosListInicio.innerHTML = html;
  }
}

function atualizarStatusWhatsapp(status, qrCode) {
  ultimoStatusWhatsapp = status || 'nao_configurado';
  const mapa = {
    nao_configurado: 'Aguardando cadastro',
    iniciando: 'Preparando QR',
    qr_pronto: 'QR pronto',
    conectado: 'Conectado',
    isLogged: 'Conectado',
    qrReadSuccess: 'Conectado',
    erro: 'Erro',
  };

  whatsappStatusBadge.textContent = mapa[status] || status || 'Aguardando cadastro';

  if (qrCode) {
    qrCodeImage.hidden = false;
    qrCodeImage.src = qrCode;
    qrStatusMessage.textContent = 'Escaneie este QR Code com o WhatsApp da barbearia.';
    return;
  }

  if (status === 'conectado' || status === 'isLogged' || status === 'qrReadSuccess') {
    qrCodeImage.hidden = true;
    qrStatusMessage.textContent = 'WhatsApp conectado com sucesso. Os agendamentos ja podem funcionar.';
    return;
  }

  if (status === 'erro') {
    qrCodeImage.hidden = true;
  }

  qrCodeImage.hidden = true;
}

function obterPixPagamentoAtual(estado = {}) {
  return estado?.pix || pixConfig || null;
}

function preencherPagamentoPendente(estado = {}) {
  const pix = obterPixPagamentoAtual(estado);

  paymentReminderText.textContent = estado?.mensagem || 'Pagamento pendente.';
  paymentPixValor.textContent = `Valor: ${currency.format(Number(pix?.valor || valorMensalAtual || 0))}`;
  paymentPixCopiaCola.textContent = pix?.copiaCola ? `Pix copia e cola: ${pix.copiaCola}` : 'Codigo Pix indisponivel.';
  paymentPixInstruction.textContent = pix?.instrucoes || 'Apos o pagamento, envie o comprovante no WhatsApp.';
  paymentWhatsappButton.href = pix?.whatsappLink || '#';

  if (pix?.qrCodeImageUrl) {
    paymentPixQrImage.hidden = false;
    paymentPixQrImage.src = pix.qrCodeImageUrl;
  } else {
    paymentPixQrImage.hidden = true;
    paymentPixQrImage.removeAttribute('src');
  }

  blockedPixCard.hidden = !pix?.copiaCola;
  blockedPixValorLabel.textContent = `Valor: ${currency.format(Number(pix?.valor || valorMensalAtual || 0))}`;
  blockedPixFavorecidoLabel.textContent = `Favorecido: ${pix?.favorecido || '--'}`;
  blockedPixChaveLabel.textContent = `Chave Pix: ${pix?.chaveExibicao || pix?.chave || '--'}`;
  blockedPixCopiaColaLabel.textContent = pix?.copiaCola ? `Pix copia e cola: ${pix.copiaCola}` : 'Pix copia e cola indisponivel.';
  blockedWhatsappButton.href = pix?.whatsappLink || '#';

  if (pix?.qrCodeImageUrl) {
    blockedPixQrPanel.hidden = false;
    blockedPixQrImage.hidden = false;
    blockedPixQrImage.src = pix.qrCodeImageUrl;
  } else {
    blockedPixQrPanel.hidden = true;
    blockedPixQrImage.hidden = true;
    blockedPixQrImage.removeAttribute('src');
  }
}

function mostrarEstadoPagamento(estado = {}) {
  painelLiberadoMessage.hidden = true;
  paymentReminderCard.hidden = false;
  painelBloqueadoMessage.hidden = estado?.status !== 'bloqueado';
  blockedMessageText.textContent = estado?.status === 'bloqueado' ? 'Pagamento pendente.' : estado?.mensagem || 'Pagamento pendente.';
  generateQrButton.disabled = true;
  preencherPagamentoPendente(estado);
  setActiveSection('atualizacao');
}

async function atualizarPixBloqueado() {
  const mostrarPix = Boolean(pixConfig?.chave);
  blockedPixCard.hidden = !mostrarPix;

  if (!mostrarPix) {
    blockedPixQrPanel.hidden = true;
    blockedPixQrImage.hidden = true;
    blockedPixQrImage.removeAttribute('src');
    return;
  }

  blockedPixFavorecidoLabel.textContent = `Favorecido: ${pixConfig.favorecido}`;
  blockedPixChaveLabel.textContent = `Chave Pix: ${pixConfig.chave}`;

  try {
    const pagamentoPix = await buscarJson('/api/publico/pix/qrcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valor: valorMensalAtual,
        descricao: 'Assinatura mensal Salãoflix',
      }),
    });

    blockedPixQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(
      pagamentoPix.payload
    )}`;
    blockedPixQrPanel.hidden = false;
    blockedPixQrImage.hidden = false;
  } catch (error) {
    console.error(error);
    blockedPixQrPanel.hidden = true;
    blockedPixQrImage.hidden = true;
  }
}

async function mostrarPainelBloqueado(mensagem) {
  painelLiberadoMessage.hidden = true;
  paymentReminderCard.hidden = true;
  painelBloqueadoMessage.hidden = false;
  blockedMessageText.textContent = mensagem;
  generateQrButton.disabled = true;
  setActiveSection('atualizacao');
  await atualizarPixBloqueado();
}

function atualizarLembretePagamento(assinatura) {
  const lembrete = assinatura?.lembrete_pagamento;

  if (!lembrete?.mensagem) {
    paymentReminderCard.hidden = true;
    return;
  }

  preencherPagamentoPendente({
    mensagem: lembrete.mensagem,
    pix: assinatura.pix,
  });
  paymentReminderCard.hidden = false;
}

function tratarErroSessao(error) {
  if (error.status === 401) {
    limparSessaoBarbeiro();
    window.location.href = '/';
    return true;
  }

  if (error.status === 403) {
    void mostrarEstadoPagamento(error.details || { mensagem: error.message });
    return true;
  }

  return false;
}

async function carregarPainelBarbeiro() {
  if (!authToken) {
    window.location.href = '/';
    return;
  }

  try {
    const config = await buscarJson('/api/publico/assinatura-config');
    supportNumberLabel.textContent = `Suporte: ${config.suporteNumero || '--'}`;
    pixConfig = config.pix || null;
    valorMensalAtual = Number(config.valorMensal || 1);
    whatsappEnabled = Boolean(config.whatsappEnabled);

    const assinatura = await buscarJson('/api/barbeiro/me');
    assinaturaAtualId = assinatura.id;
    generateQrButton.disabled = !whatsappEnabled;
    generateQrButton.hidden = false;
    openLocalWhatsappButton.hidden = true;
    whatsappHelpText.textContent = whatsappEnabled
      ? 'Seu acesso esta liberado. Gere o QR Code diretamente por este painel para conectar o WhatsApp.'
      : (config.whatsappSetupMessage || 'O WhatsApp nao esta disponivel no momento.');
    whatsappStatusBadge.textContent = whatsappEnabled ? 'Pronto para conectar' : 'Configurar';
    qrCodeImage.hidden = true;
    qrStatusMessage.textContent = whatsappEnabled
      ? 'Clique em Gerar QR Code para iniciar a conexao do WhatsApp.'
      : 'O WhatsApp nao esta disponivel no momento.';

    const [agendamentos, dia, mes, ano, bloqueios] = await Promise.all([
      buscarJson('/api/agendamentos'),
      buscarJson('/api/faturamento?periodo=dia'),
      buscarJson('/api/faturamento?periodo=mes'),
      buscarJson('/api/faturamento?periodo=ano'),
      buscarJson('/api/bloqueios'),
    ]);

    painelLiberadoMessage.hidden = false;
    atualizarLembretePagamento(assinatura);
    painelBloqueadoMessage.hidden = true;
    renderizarAgendamentos(agendamentos);
    renderizarFaturamento([dia, mes, ano]);
    renderizarBloqueios(bloqueios);
    preencherConfiguracoesPainel(assinatura);
    if (mesFaturamentoInput && !mesFaturamentoInput.value) {
      mesFaturamentoInput.value = new Date().toISOString().slice(0, 7);
    }
    await carregarFaturamentoMesEscolhido();
    await consultarStatusWhatsapp();
    setActiveSection(activeSectionId || 'inicio');
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    mostrarMensagemTopo('Nao consegui atualizar o painel agora.');
    if (formMessage) {
      formMessage.textContent = 'Nao consegui carregar o painel do salao.';
    }
  }
}

async function excluirAgendamento(id) {
  await buscarJson(`/api/agendamentos/${id}`, { method: 'DELETE' });
}

async function excluirBloqueio(id) {
  await buscarJson(`/api/bloqueios/${id}`, { method: 'DELETE' });
}

async function consultarStatusWhatsapp() {
  if (!assinaturaAtualId || !authToken || !whatsappEnabled) {
    return;
  }

  try {
    const status = await buscarJson(`/api/publico/assinaturas/${assinaturaAtualId}/whatsapp/status`);
    atualizarStatusWhatsapp(status.status, status.qrCode);

    if (status.mensagem) {
      qrStatusMessage.textContent = status.mensagem;
    }

    if (status.qrCode) {
      ultimoQrGeradoEm = Date.now();
    }

    if (status.status === 'erro') {
      qrStatusMessage.textContent = status.ultimoErro || status.mensagem || 'Nao consegui iniciar o WhatsApp.';
    }

    if (status.conectado || status.status === 'conectado' || status.status === 'isLogged' || status.status === 'qrReadSuccess') {
      clearInterval(whatsappPolling);
      whatsappPolling = null;
    }
  } catch (error) {
    console.error(error);
    qrStatusMessage.textContent = error.message;
  }
}

function iniciarPollingWhatsapp() {
  if (whatsappPolling) {
    clearInterval(whatsappPolling);
  }

  whatsappPolling = setInterval(consultarStatusWhatsapp, 5000);
}

function iniciarAutoRefreshPainel() {
  if (painelAutoRefresh) {
    clearInterval(painelAutoRefresh);
  }

  painelAutoRefresh = setInterval(() => {
    if (!document.hidden && authToken) {
      void carregarPainelBarbeiro();
    }
  }, 30000);
}

async function solicitarQrWhatsapp({ silencioso = false } = {}) {
  if (qrRequestInFlight) {
    return null;
  }

  qrRequestInFlight = true;

  if (!silencioso) {
    generateQrButton.disabled = true;
    generateQrButton.textContent = 'Gerando QR...';
    qrStatusMessage.textContent = 'Gerando QR Code do WhatsApp...';
    whatsappStatusBadge.textContent = 'Preparando QR';
  }

  let ultimaFalha = null;

  try {
    for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
      try {
        const resposta = await buscarJson('/api/whatsapp/qr', {
          method: 'GET',
        });

        if (resposta.status === 'success') {
          const statusRecebido =
            resposta.whatsappStatus || (resposta.conectado ? 'conectado' : resposta.qr ? 'qr_pronto' : 'iniciando');
          atualizarStatusWhatsapp(statusRecebido, resposta.qr);
          qrStatusMessage.textContent = resposta.message || 'QR Code atualizado com sucesso.';

          if (resposta.qr) {
            ultimoQrGeradoEm = Date.now();
          }

          return resposta;
        }

        ultimaFalha = new Error(resposta.message || 'Falha ao gerar QR Code.');
      } catch (error) {
        ultimaFalha = error;
      }

      if (tentativa < 3) {
        if (!silencioso) {
          qrStatusMessage.textContent = `Tentando novamente gerar o QR Code (${tentativa}/3)...`;
        }
        await esperar(2000);
      }
    }

    throw ultimaFalha || new Error('Falha ao gerar QR Code do WhatsApp.');
  } finally {
    qrRequestInFlight = false;
    if (!silencioso) {
      generateQrButton.disabled = !whatsappEnabled;
      generateQrButton.textContent = 'Gerar QR Code';
    }
  }
}

async function salvarBloqueio({ data, hora, form, messageNode }) {
  await buscarJson('/api/bloqueios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, hora }),
  });

  if (messageNode) {
    messageNode.textContent = 'Horario bloqueado com sucesso.';
  }

  if (form) {
    form.reset();
  }

  await carregarPainelBarbeiro();
}

async function salvarServicosPainel() {
  if (!assinaturaAtualId) {
    throw new Error('Entre no painel primeiro.');
  }

  await buscarJson(`/api/publico/assinaturas/${assinaturaAtualId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      diasFuncionamento: coletarDiasSelecionados(diasFuncionamentoPainel),
      horarioAbertura: painelHorarioAberturaInput.value,
      horarioAlmocoInicio: painelHorarioAlmocoInicioInput.value,
      horarioAlmocoFim: painelHorarioAlmocoFimInput.value,
      horarioFechamento: painelHorarioFechamentoInput.value,
      localizacaoCidade: painelLocalizacaoCidadeInput?.value.trim() || '',
      localizacaoRua: painelLocalizacaoRuaInput?.value.trim() || '',
      localizacaoReferencia: painelLocalizacaoReferenciaInput?.value.trim() || '',
      servicos: coletarServicos(painelServiceRows),
    }),
  });
}

async function lidarEnvioBloqueio(event, campos) {
  event.preventDefault();

  try {
    await salvarBloqueio({
      data: campos.data.value,
      hora: campos.hora.value,
      form: campos.form,
      messageNode: campos.message,
    });
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    if (campos.message) {
      campos.message.textContent = 'Nao consegui salvar o bloqueio.';
    }
  }
}

bloqueioForm?.addEventListener('submit', (event) =>
  lidarEnvioBloqueio(event, {
    data: document.getElementById('dataInput'),
    hora: document.getElementById('horaInput'),
    form: bloqueioForm,
    message: formMessage,
  })
);

bloqueioFormInicio?.addEventListener('submit', (event) =>
  lidarEnvioBloqueio(event, {
    data: document.getElementById('dataInputInicio'),
    hora: document.getElementById('horaInputInicio'),
    form: bloqueioFormInicio,
    message: formMessageInicio,
  })
);

configuracoesBarbeiroForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!assinaturaAtualId) {
    configuracoesMessage.textContent = 'Entre no painel primeiro.';
    return;
  }

  try {
    await salvarServicosPainel();

    configuracoesMessage.textContent = 'Configuracoes atualizadas com sucesso.';
    await carregarPainelBarbeiro();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    configuracoesMessage.textContent = 'Nao consegui atualizar as configuracoes da barbearia.';
  }
});

function configurarRemocaoServico(container) {
  container.addEventListener('click', (event) => {
    const botao = event.target.closest('[data-remove-service]');

    if (!botao) {
      return;
    }

    const rows = container.querySelectorAll('.service-row');

    if (rows.length === 1) {
      return;
    }

    botao.closest('.service-row')?.remove();
  });
}

configurarRemocaoServico(painelServiceRows);
addPainelServiceButton.addEventListener('click', () => {
  criarLinhaServico(painelServiceRows);
  renderizarPrecosAtuais(coletarServicos(painelServiceRows));
});
painelServiceRows.addEventListener('input', () => {
  renderizarPrecosAtuais(coletarServicos(painelServiceRows));
});
savePainelServicesButton?.addEventListener('click', async () => {
  if (servicesMessage) {
    servicesMessage.textContent = 'Salvando servicos...';
  }

  try {
    await salvarServicosPainel();
    if (servicesMessage) {
      servicesMessage.textContent = 'Servicos salvos com sucesso. Eles ja ficam disponiveis no painel e no WhatsApp.';
    }
    await carregarPainelBarbeiro();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    if (servicesMessage) {
      servicesMessage.textContent = error.message || 'Nao consegui salvar os servicos.';
    }
  }
});
menuButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setActiveSection(button.dataset.sectionTarget || 'inicio');
  });
});

generateQrButton.addEventListener('click', async () => {
  if (!assinaturaAtualId) {
    qrStatusMessage.textContent = 'Entre no painel antes de gerar o QR Code.';
    return;
  }

  if (!whatsappEnabled) {
    qrStatusMessage.textContent = 'O WhatsApp nao esta disponivel no momento.';
    whatsappStatusBadge.textContent = 'Configurar';
    return;
  }

  try {
    if (ultimoStatusWhatsapp === 'iniciando') {
      qrStatusMessage.textContent = 'A conexao ja esta em andamento. Aguarde alguns segundos para o QR aparecer.';
      iniciarPollingWhatsapp();
      return;
    }

    const resposta = await solicitarQrWhatsapp();

    if (resposta?.conectado) {
      clearInterval(whatsappPolling);
      whatsappPolling = null;
      return;
    }

    await consultarStatusWhatsapp();
    iniciarPollingWhatsapp();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    qrStatusMessage.textContent = error.message || 'Nao consegui gerar o QR Code apos 3 tentativas.';
    whatsappStatusBadge.textContent = 'Erro';
  }
});

agendamentosTable?.addEventListener('click', async (event) => {
  const botao = event.target.closest('button[data-id]');

  if (!botao) {
    return;
  }

  const { id } = botao.dataset;
  const confirmou = window.confirm('Tem certeza que deseja excluir este agendamento?');

  if (!confirmou) {
    return;
  }

  try {
    botao.disabled = true;
    await excluirAgendamento(id);
    if (formMessage) {
      formMessage.textContent = 'Agendamento excluido com sucesso.';
    }
    await carregarPainelBarbeiro();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    if (formMessage) {
      formMessage.textContent = 'Nao consegui excluir o agendamento.';
    }
    botao.disabled = false;
  }
});

agendamentosTableInicio?.addEventListener('click', async (event) => {
  const botao = event.target.closest('button[data-id]');

  if (!botao) {
    return;
  }

  const { id } = botao.dataset;
  const confirmou = window.confirm('Tem certeza que deseja excluir este agendamento?');

  if (!confirmou) {
    return;
  }

  try {
    botao.disabled = true;
    await excluirAgendamento(id);
    if (formMessageInicio) {
      formMessageInicio.textContent = 'Agendamento excluido com sucesso.';
    }
    await carregarPainelBarbeiro();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    if (formMessageInicio) {
      formMessageInicio.textContent = 'Nao consegui excluir o agendamento.';
    }
    botao.disabled = false;
  }
});

async function lidarCliqueExclusaoBloqueio(event, messageNode) {
  const botao = event.target.closest('button[data-bloqueio-id]');

  if (!botao) {
    return;
  }

  const { bloqueioId } = botao.dataset;
  const confirmou = window.confirm('Tem certeza que deseja excluir este bloqueio?');

  if (!confirmou) {
    return;
  }

  try {
    botao.disabled = true;
    await excluirBloqueio(bloqueioId);
    if (messageNode) {
      messageNode.textContent = 'Bloqueio excluido com sucesso.';
    }
    await carregarPainelBarbeiro();
  } catch (error) {
    console.error(error);
    if (tratarErroSessao(error)) {
      return;
    }
    if (messageNode) {
      messageNode.textContent = 'Nao consegui excluir o bloqueio.';
    }
    botao.disabled = false;
  }
}

bloqueiosList?.addEventListener('click', (event) => {
  void lidarCliqueExclusaoBloqueio(event, formMessage);
});

bloqueiosListInicio?.addEventListener('click', (event) => {
  void lidarCliqueExclusaoBloqueio(event, formMessageInicio);
});

logoutBarbeiroButton?.addEventListener('click', async () => {
  const textoOriginal = logoutBarbeiroButton.textContent;
  logoutBarbeiroButton.disabled = true;
  mostrarMensagemTopo('Saindo do painel...');

  try {
    await buscarJson('/api/barbeiro/logout', { method: 'POST' });
  } catch (error) {
    console.error(error);
  } finally {
    limparSessaoBarbeiro();
    window.location.replace('/');
    logoutBarbeiroButton.disabled = false;
    logoutBarbeiroButton.textContent = textoOriginal;
  }
});

refreshButton?.addEventListener('click', async () => {
  const textoOriginal = refreshButton.textContent;
  refreshButton.disabled = true;
  refreshButton.textContent = 'Atualizando...';
  mostrarMensagemTopo('Atualizando os dados do painel...');

  try {
    await carregarPainelBarbeiro();
    mostrarMensagemTopo('Painel atualizado com sucesso.');
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = textoOriginal;
  }
});

copyPixButton?.addEventListener('click', async () => {
  const pix = obterPixPagamentoAtual();

  if (!pix?.copiaCola) {
    mostrarMensagemTopo('Codigo Pix indisponivel agora.');
    return;
  }

  try {
    await navigator.clipboard.writeText(pix.copiaCola);
    mostrarMensagemTopo('Codigo Pix copiado com sucesso.');
  } catch (error) {
    console.error(error);
    mostrarMensagemTopo('Nao consegui copiar o codigo Pix.');
  }
});

mesFaturamentoInput?.addEventListener('change', () => {
  void carregarFaturamentoMesEscolhido();
});

renderizarDiasFuncionamento(diasFuncionamentoPainel, [1, 2, 3, 4, 5, 6]);
setActiveSection('inicio');
iniciarAutoRefreshPainel();
carregarPainelBarbeiro();
