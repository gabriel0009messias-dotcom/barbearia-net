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
const disconnectWhatsappButton = document.getElementById('disconnectWhatsappButton');
const qrCodeImage = document.getElementById('qrCodeImage');
const pairingInstructions = document.getElementById('pairingInstructions');
const pairingCodeLabel = document.getElementById('pairingCodeLabel');
const generatePairingButton = document.getElementById('generatePairingButton');
const whatsappPairingNumber = document.getElementById('whatsappPairingNumber');
const pairingCodeValue = document.getElementById('pairingCodeValue');
const copyPairingCodeButton = document.getElementById('copyPairingCodeButton');
const openLocalWhatsappButton = document.getElementById('openLocalWhatsappButton');
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
let painelAutoRefresh = null;
let pairingCodeAtual = '';
let whatsappRequestInFlight = false;
let whatsappStatusInFlight = false;
let whatsappConnected = false;
let whatsappStatusPaused = false;
let whatsappEpoch = 0;
let whatsappPollingDeadline = 0;
let whatsappPollingErrors = 0;

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
  const { timeoutMs = 30000, ...fetchOptions } = options;
  const headers = getHeaders(fetchOptions.headers || {});
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...fetchOptions, headers, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.success === false || payload.ok === false) {
      const erro = new Error(payload?.message || payload?.mensagem || payload?.error || `O servidor retornou uma resposta invalida (HTTP ${response.status}). Tente novamente.`);
      erro.status = response.status;
      erro.details = payload;
      throw erro;
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('O servidor demorou para responder. Tente novamente em alguns instantes.');
    if (error instanceof TypeError) throw new Error('Nao foi possivel acessar o servidor. Verifique sua conexao e tente novamente.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function limparSessaoBarbeiro() {
  pararPollingWhatsapp();
  whatsappEpoch += 1;
  authToken = null;
  assinaturaAtualId = null;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function mostrarMensagemTopo(mensagem = '') {
  if (topbarActionMessage) {
    topbarActionMessage.textContent = mensagem;
  }
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

function atualizarBotoesWhatsapp() {
  generatePairingButton.disabled = !whatsappEnabled || whatsappRequestInFlight || whatsappConnected;
  generateQrButton.disabled = !whatsappEnabled || whatsappRequestInFlight || whatsappConnected;
  disconnectWhatsappButton.disabled = !whatsappEnabled || whatsappRequestInFlight;
  generatePairingButton.textContent = whatsappRequestInFlight ? 'Gerando codigo...' : whatsappConnected ? 'WhatsApp conectado' : 'Conectar WhatsApp';
}

function limparCodigosWhatsapp() {
  pairingCodeAtual = '';
  pairingCodeValue.textContent = '';
  pairingCodeValue.hidden = true;
  pairingCodeLabel.hidden = true;
  pairingInstructions.hidden = true;
  copyPairingCodeButton.hidden = true;
  qrCodeImage.hidden = true;
  qrCodeImage.removeAttribute('src');
}

function atualizarStatusWhatsapp(status, connected = false) {
  whatsappConnected = connected || ['connected', 'conectado', 'isLogged', 'qrReadSuccess'].includes(status);
  const mapa = { disconnected: 'Desconectado', nao_configurado: 'Desconectado', pairing: 'Aguardando conexao', pairing_code: 'Codigo gerado', iniciando: 'Conectando', error: 'Falha na conexao', erro: 'Falha na conexao' };
  whatsappStatusBadge.textContent = whatsappConnected ? 'Conectado' : mapa[status] || status || 'Desconectado';
  if (whatsappConnected) {
    limparCodigosWhatsapp();
    pararPollingWhatsapp();
    qrStatusMessage.textContent = 'WhatsApp conectado com sucesso.';
  }
  atualizarBotoesWhatsapp();
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
    atualizarBotoesWhatsapp();
    openLocalWhatsappButton.hidden = true;
    whatsappHelpText.textContent = whatsappEnabled
      ? 'Seu acesso esta liberado. Informe seu numero para conectar o WhatsApp por codigo.'
      : (config.whatsappSetupMessage || 'O WhatsApp nao esta disponivel no momento.');
    if (!whatsappRequestInFlight && !pairingCodeAtual && !whatsappConnected && !whatsappStatusPaused && !whatsappPolling) {
      whatsappStatusBadge.textContent = whatsappEnabled ? 'Pronto para conectar' : 'Configurar';
      qrStatusMessage.textContent = whatsappEnabled ? 'Informe seu numero e clique em Conectar WhatsApp.' : 'O WhatsApp nao esta disponivel no momento.';
    }

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
    void consultarStatusWhatsapp();
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

function pararPollingWhatsapp() {
  clearTimeout(whatsappPolling);
  whatsappPolling = null;
}

async function consultarStatusWhatsapp() {
  if (!assinaturaAtualId || !authToken || !whatsappEnabled || whatsappRequestInFlight || whatsappStatusInFlight || whatsappStatusPaused) return;
  const epoch = whatsappEpoch;
  whatsappStatusInFlight = true;
  try {
    const resposta = await buscarJson(`/api/publico/assinaturas/${assinaturaAtualId}/whatsapp/status`, { timeoutMs: 15000 });
    if (epoch !== whatsappEpoch) return;
    whatsappPollingErrors = 0;
    atualizarStatusWhatsapp(resposta.status, resposta.connected || resposta.conectado);
    if (!whatsappConnected) qrStatusMessage.textContent = resposta.message || resposta.mensagem || 'Aguardando conexao pelo WhatsApp.';
  } catch (error) {
    if (epoch !== whatsappEpoch) return;
    whatsappPollingErrors += 1;
    qrStatusMessage.textContent = error.message;
    whatsappStatusBadge.textContent = 'Falha ao consultar conexao';
    if ([400, 401, 403, 404].includes(error.status) || whatsappPollingErrors >= 3) {
      whatsappStatusPaused = true;
      pararPollingWhatsapp();
    }
    // Erros da Evolution chegam como 502/503, nunca como login expirado.
    if (error.status === 401) {
      whatsappEnabled = false;
      atualizarBotoesWhatsapp();
      qrStatusMessage.textContent = 'Sua sessao expirou. Entre novamente no painel.';
    }
  } finally {
    whatsappStatusInFlight = false;
  }
}

function iniciarPollingWhatsapp() {
  pararPollingWhatsapp();
  whatsappPollingDeadline = Date.now() + 180000;
  const epoch = whatsappEpoch;
  const consultar = async () => {
    if (epoch !== whatsappEpoch || whatsappStatusPaused || whatsappConnected) return;
    if (Date.now() >= whatsappPollingDeadline) {
      pararPollingWhatsapp();
      whatsappStatusPaused = true;
      limparCodigosWhatsapp();
      qrStatusMessage.textContent = 'O tempo para confirmar a conexao terminou. Clique em Conectar WhatsApp para tentar novamente.';
      return;
    }
    await consultarStatusWhatsapp();
    if (epoch === whatsappEpoch && !whatsappStatusPaused && !whatsappConnected) whatsappPolling = setTimeout(consultar, 5000);
  };
  whatsappPolling = setTimeout(consultar, 5000);
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

function numeroWhatsappValido(numero = '') {
  let digitos = String(numero).replace(/\D/g, '');
  if (digitos.startsWith('00')) digitos = digitos.slice(2);
  if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
  return /^55[1-9]{2}(?:[2-5]\d{7}|9\d{8})$/.test(digitos);
}

async function solicitarConexaoWhatsapp(modo = 'pairing') {
  if (whatsappRequestInFlight || whatsappConnected || !assinaturaAtualId || !whatsappEnabled) return;
  const numero = whatsappPairingNumber.value.trim();
  if (modo === 'pairing' && !numeroWhatsappValido(numero)) throw new Error('Numero de WhatsApp invalido. Informe DDD e numero.');
  whatsappEpoch += 1;
  whatsappRequestInFlight = true;
  whatsappStatusPaused = false;
  whatsappPollingErrors = 0;
  pararPollingWhatsapp();
  limparCodigosWhatsapp();
  atualizarBotoesWhatsapp();
  whatsappStatusBadge.textContent = 'Conectando';
  qrStatusMessage.textContent = modo === 'pairing' ? 'Solicitando codigo de conexao...' : 'Gerando QR Code...';
  try {
    const resposta = await buscarJson(`/api/publico/assinaturas/${assinaturaAtualId}/whatsapp/${modo === 'pairing' ? 'pairing-code' : 'iniciar'}`, {
      method: 'POST', body: JSON.stringify(modo === 'pairing' ? { phone: numero } : {}), timeoutMs: 70000,
    });
    atualizarStatusWhatsapp(resposta.status, resposta.connected || resposta.conectado);
    if (whatsappConnected) return;
    if (modo === 'pairing') {
      pairingCodeAtual = resposta.pairingCode || resposta.code || '';
      if (!pairingCodeAtual) throw new Error('O servidor nao retornou o codigo de conexao. Tente novamente.');
      pairingCodeValue.textContent = pairingCodeAtual.replace(/^([A-Z0-9]{4})([A-Z0-9]{4})$/i, '$1-$2');
      pairingCodeValue.hidden = false;
      pairingCodeLabel.hidden = false;
      pairingInstructions.hidden = false;
      copyPairingCodeButton.hidden = false;
      qrStatusMessage.textContent = 'Codigo gerado. Digite este codigo no WhatsApp do celular.';
    } else {
      const qr = resposta.qrCode || resposta.qr;
      if (!qr) throw new Error(resposta.message || resposta.mensagem || 'O servidor ainda nao disponibilizou o QR Code. Tente novamente.');
      qrCodeImage.src = qr;
      qrCodeImage.hidden = false;
      qrStatusMessage.textContent = 'Abra Aparelhos conectados no WhatsApp e escaneie o QR Code.';
    }
    iniciarPollingWhatsapp();
  } catch (error) {
    whatsappStatusPaused = true;
    if (error.status === 401) whatsappEnabled = false;
    limparCodigosWhatsapp();
    throw error;
  } finally {
    whatsappRequestInFlight = false;
    atualizarBotoesWhatsapp();
  }
}

async function solicitarPairingCode() {
  return solicitarConexaoWhatsapp('pairing');
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

generatePairingButton?.addEventListener('click', async () => {
  if (!assinaturaAtualId || !whatsappEnabled) return;
  try {
    await solicitarPairingCode();
  } catch (error) {
    qrStatusMessage.textContent = error.message || 'Nao foi possivel gerar o codigo de conexao.';
    whatsappStatusBadge.textContent = 'Erro';
  }
});

generateQrButton?.addEventListener('click', async () => {
  try { await solicitarConexaoWhatsapp('qr'); }
  catch (error) { qrStatusMessage.textContent = error.message; whatsappStatusBadge.textContent = 'Falha na conexao'; }
});

disconnectWhatsappButton?.addEventListener('click', async () => {
  if (whatsappRequestInFlight || !assinaturaAtualId) return;
  whatsappRequestInFlight = true;
  whatsappEpoch += 1;
  pararPollingWhatsapp();
  atualizarBotoesWhatsapp();
  qrStatusMessage.textContent = 'Desconectando WhatsApp...';
  try {
    await buscarJson(`/api/publico/assinaturas/${assinaturaAtualId}/whatsapp/logout`, { method: 'DELETE', timeoutMs: 20000 });
    limparCodigosWhatsapp();
    whatsappStatusPaused = false;
    atualizarStatusWhatsapp('disconnected');
    qrStatusMessage.textContent = 'WhatsApp desconectado. Voce pode iniciar uma nova conexao.';
  } catch (error) { qrStatusMessage.textContent = error.message; }
  finally { whatsappRequestInFlight = false; atualizarBotoesWhatsapp(); }
});

copyPairingCodeButton?.addEventListener('click', async () => {
  if (!pairingCodeAtual) return;
  try {
    await navigator.clipboard.writeText(pairingCodeAtual);
    qrStatusMessage.textContent = 'Codigo copiado.';
  } catch (_) {
    qrStatusMessage.textContent = 'Nao foi possivel copiar. Selecione o codigo e copie manualmente.';
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
