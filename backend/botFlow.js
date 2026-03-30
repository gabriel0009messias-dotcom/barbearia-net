const db = require('./database');

const estadosPorSessao = new Map();
const contextosPorSessao = new Map();
const mensagensEnviadasPeloBot = new Set();

function getEstados(sessionKey) {
  if (!estadosPorSessao.has(sessionKey)) {
    estadosPorSessao.set(sessionKey, {});
  }

  return estadosPorSessao.get(sessionKey);
}

function resetarEstado(sessionKey, user) {
  const estados = getEstados(sessionKey);
  estados[user] = { etapa: 'inicio' };
}

function definirContextoSessao(sessionKey, options = {}) {
  contextosPorSessao.set(sessionKey, {
    apiBaseUrl: options.apiBaseUrl || null,
    barberToken: options.barberToken || null,
    bridgeToken: options.bridgeToken || null,
    assinaturaId: options.assinaturaId || null,
  });
}

function getContextoSessao(sessionKey) {
  return contextosPorSessao.get(sessionKey) || {};
}

function normalizarTexto(texto = '') {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function formatarPreco(preco) {
  return `R$ ${Number(preco).toFixed(2).replace('.', ',')}`;
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve(this);
    });
  });
}

function usarApiRemota(sessionKey) {
  const contexto = getContextoSessao(sessionKey);
  return Boolean(contexto.apiBaseUrl && (contexto.bridgeToken || contexto.barberToken));
}

async function buscarApi(sessionKey, path, options = {}) {
  const contexto = getContextoSessao(sessionKey);

  if (!contexto.apiBaseUrl || (!contexto.bridgeToken && !contexto.barberToken)) {
    throw new Error('Bot local sem conexao autorizada com a API publicada.');
  }

  const response = await fetch(`${String(contexto.apiBaseUrl).replace(/\/$/, '')}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(contexto.bridgeToken ? { 'x-whatsapp-bridge-token': contexto.bridgeToken } : {}),
      ...(contexto.barberToken ? { 'x-barbeiro-token': contexto.barberToken } : {}),
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.error || `Falha ao acessar ${path}`);
  }

  return payload;
}

async function carregarServicos(assinaturaId, sessionKey) {
  if (usarApiRemota(sessionKey) && assinaturaId) {
    const assinatura = await buscarApi(sessionKey, `/api/publico/assinaturas/${assinaturaId}`);
    return assinatura.servicos || [];
  }

  if (assinaturaId) {
    const servicosAssinatura = await allAsync(
      `SELECT id, nome, preco
       FROM servicos_assinatura
       WHERE assinatura_id = ?
       ORDER BY id ASC`,
      [assinaturaId]
    );

    if (servicosAssinatura.length) {
      return servicosAssinatura;
    }
  }

  return allAsync('SELECT id, nome, preco FROM servicos ORDER BY id ASC');
}

async function carregarConfiguracaoAgenda(assinaturaId, sessionKey) {
  if (usarApiRemota(sessionKey) && assinaturaId) {
    const assinatura = await buscarApi(sessionKey, `/api/publico/assinaturas/${assinaturaId}`);

    return {
      diasFuncionamento: assinatura.dias_funcionamento || [1, 2, 3, 4, 5, 6],
      horarioAbertura: assinatura.horario_abertura || '08:00',
      horarioAlmocoInicio: assinatura.horario_almoco_inicio || '12:00',
      horarioAlmocoFim: assinatura.horario_almoco_fim || '13:00',
      horarioFechamento: assinatura.horario_fechamento || '18:00',
    };
  }

  if (!assinaturaId) {
    return {
      diasFuncionamento: [1, 2, 3, 4, 5, 6],
      horarioAbertura: '08:00',
      horarioAlmocoInicio: '12:00',
      horarioAlmocoFim: '13:00',
      horarioFechamento: '18:00',
    };
  }

  const assinatura = await getAsync(
    `SELECT dias_funcionamento, horario_abertura, horario_almoco_inicio, horario_almoco_fim, horario_fechamento
     FROM assinaturas
     WHERE id = ?`,
    [assinaturaId]
  );

  const diasFuncionamento = String(assinatura?.dias_funcionamento || '1,2,3,4,5,6')
    .split(',')
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);

  return {
    diasFuncionamento: diasFuncionamento.length ? diasFuncionamento : [1, 2, 3, 4, 5, 6],
    horarioAbertura: assinatura?.horario_abertura || '08:00',
    horarioAlmocoInicio: assinatura?.horario_almoco_inicio || '12:00',
    horarioAlmocoFim: assinatura?.horario_almoco_fim || '13:00',
    horarioFechamento: assinatura?.horario_fechamento || '18:00',
  };
}

async function carregarAcessoAssinatura(assinaturaId, sessionKey) {
  if (usarApiRemota(sessionKey) && assinaturaId) {
    return buscarApi(sessionKey, `/api/publico/assinaturas/${assinaturaId}/acesso`);
  }

  if (!assinaturaId) {
    return {
      liberado: true,
      mensagem: '',
    };
  }

  const assinatura = await getAsync(
    `SELECT id, status, trial_expires_at
     FROM assinaturas
     WHERE id = ?`,
    [assinaturaId]
  );

  if (!assinatura) {
    return {
      liberado: false,
      mensagem: 'Essa assinatura nao foi encontrada. Entre em contato com o suporte.',
    };
  }

  if (assinatura.status === 'ativo') {
    return {
      liberado: true,
      mensagem: '',
    };
  }

  return {
    liberado: false,
    mensagem: 'Atendimento temporariamente bloqueado. Regularize o Pix da barbearia para voltar a agendar.',
  };
}

function formatarData(data) {
  return new Date(`${data}T00:00:00`).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
  });
}

function montarListaPrecos(servicos) {
  return servicos.map((servico) => `- ${servico.nome}: ${formatarPreco(servico.preco)}`).join('\n');
}

function montarMenuServicosFallback(servicos) {
  return servicos
    .map((servico, index) => `${index + 1}. ${servico.nome} - ${formatarPreco(servico.preco)}`)
    .join('\n');
}

function montarResumoAgendamento(user, estado) {
  return [
    'Resumo do agendamento:',
    `Cliente: ${user}`,
    `Servico: ${estado.servico.nome}`,
    `Preco: ${formatarPreco(estado.servico.preco)}`,
    `Data: ${new Date(`${estado.data}T00:00:00`).toLocaleDateString('pt-BR')}`,
    `Horario: ${estado.hora}`,
  ].join('\n');
}

function converterHorarioParaMinutos(horario) {
  const [hora, minuto] = String(horario).split(':').map((item) => Number.parseInt(item, 10));
  return hora * 60 + minuto;
}

function minutosParaHorario(minutos) {
  const hora = Math.floor(minutos / 60);
  const minuto = minutos % 60;
  return `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`;
}

function proximasDatas(configuracaoAgenda) {
  const datas = [];

  for (let i = 0; i < 14; i += 1) {
    const data = new Date();
    data.setDate(data.getDate() + i);

    if (!configuracaoAgenda.diasFuncionamento.includes(data.getDay())) {
      continue;
    }

    datas.push({
      valor: data.toISOString().slice(0, 10),
      titulo: data.toLocaleDateString('pt-BR', {
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
      }),
      descricao: i === 0 ? 'Hoje' : i === 1 ? 'Amanha' : 'Escolher este dia',
    });
  }

  return datas;
}

function horariosPadrao(configuracaoAgenda) {
  const horarios = [];
  const inicio = converterHorarioParaMinutos(configuracaoAgenda.horarioAbertura);
  const almocoInicio = converterHorarioParaMinutos(configuracaoAgenda.horarioAlmocoInicio);
  const almocoFim = converterHorarioParaMinutos(configuracaoAgenda.horarioAlmocoFim);
  const fim = converterHorarioParaMinutos(configuracaoAgenda.horarioFechamento);

  for (let minuto = inicio; minuto < fim; minuto += 30) {
    if (minuto >= almocoInicio && minuto < almocoFim) {
      continue;
    }

    horarios.push(minutosParaHorario(minuto));
  }

  return horarios;
}

async function buscarHorariosLivres(data, configuracaoAgenda, sessionKey) {
  if (usarApiRemota(sessionKey)) {
    const [agendamentos, bloqueios] = await Promise.all([
      buscarApi(sessionKey, '/api/agendamentos'),
      buscarApi(sessionKey, '/api/bloqueios'),
    ]);

    const ocupados = [
      ...agendamentos.filter((item) => item.data === data && item.status === 'confirmado').map((item) => item.hora),
      ...bloqueios.filter((item) => item.data === data).map((item) => item.hora),
    ];

    return horariosPadrao(configuracaoAgenda).filter((hora) => !ocupados.includes(hora));
  }

  const agendamentos = await allAsync(
    'SELECT hora FROM agendamentos WHERE data = ? AND status = "confirmado"',
    [data]
  );
  const bloqueios = await allAsync('SELECT hora FROM bloqueios WHERE data = ?', [data]);

  const ocupados = [...agendamentos.map((item) => item.hora), ...bloqueios.map((item) => item.hora)];
  return horariosPadrao(configuracaoAgenda).filter((hora) => !ocupados.includes(hora));
}

async function buscarDatasDisponiveis(configuracaoAgenda, sessionKey) {
  const datas = proximasDatas(configuracaoAgenda);
  const disponibilidade = await Promise.all(
    datas.map(async (data) => {
      const horariosLivres = await buscarHorariosLivres(data.valor, configuracaoAgenda, sessionKey);
      return horariosLivres.length > 0 ? data : null;
    })
  );

  return disponibilidade.filter(Boolean);
}

async function salvarAgendamento(user, estado, sessionKey) {
  if (usarApiRemota(sessionKey)) {
    await buscarApi(sessionKey, '/api/agendamentos', {
      method: 'POST',
      body: JSON.stringify({
        cliente: user,
        telefone: user,
        servicoId: estado.servico.id,
        servicoNome: estado.servico.nome,
        servicoPreco: estado.servico.preco,
        data: estado.data,
        hora: estado.hora,
      }),
    });
    return;
  }

  await runAsync('INSERT OR IGNORE INTO clientes (nome, telefone) VALUES (?, ?)', [user, user]);
  const cliente = await getAsync('SELECT id FROM clientes WHERE telefone = ?', [user]);
  await runAsync(
    'INSERT INTO agendamentos (cliente_id, servico_id, data, hora, status) VALUES (?, ?, ?, ?, ?)',
    [cliente.id, estado.servico.id, estado.data, estado.hora, 'confirmado']
  );
}

async function buscarUltimoAgendamentoConfirmado(user, sessionKey) {
  if (usarApiRemota(sessionKey)) {
    const agendamentos = await buscarApi(sessionKey, '/api/agendamentos');

    return agendamentos
      .filter((item) => item.telefone === user && item.status === 'confirmado')
      .sort((a, b) => {
        const chaveA = `${a.data || ''} ${a.hora || ''} ${String(a.id || 0).padStart(10, '0')}`;
        const chaveB = `${b.data || ''} ${b.hora || ''} ${String(b.id || 0).padStart(10, '0')}`;
        return chaveA < chaveB ? 1 : -1;
      })[0];
  }

  return getAsync(
    `SELECT
       a.id,
       a.data,
       a.hora,
       s.nome AS servico
     FROM agendamentos a
     JOIN clientes c ON c.id = a.cliente_id
     LEFT JOIN servicos s ON s.id = a.servico_id
     WHERE c.telefone = ?
       AND a.status = 'confirmado'
     ORDER BY a.data DESC, a.hora DESC, a.id DESC
     LIMIT 1`,
    [user]
  );
}

async function cancelarAgendamentoDoCliente(user, sessionKey) {
  const agendamento = await buscarUltimoAgendamentoConfirmado(user, sessionKey);

  if (!agendamento) {
    return null;
  }

  if (usarApiRemota(sessionKey)) {
    await buscarApi(sessionKey, `/api/agendamentos/${agendamento.id}`, {
      method: 'DELETE',
    });
    return agendamento;
  }

  await runAsync(
    `UPDATE agendamentos
     SET status = 'cancelado'
     WHERE id = ?`,
    [agendamento.id]
  );

  return agendamento;
}

function extrairSelecao(message) {
  const body = (message.body || '').trim();
  const payload =
    message.selectedButtonId ||
    message?.buttonsResponse?.selectedButtonId ||
    message?.listResponse?.singleSelectReply?.selectedRowId ||
    message?.listResponse?.selectedRowId ||
    message.rowId ||
    body;

  return {
    body,
    payload,
    normalizado: normalizarTexto(body),
  };
}

function extrairIdMensagem(message) {
  if (!message) return null;
  if (typeof message.id === 'string') return message.id;
  if (message.id?._serialized) return message.id._serialized;
  if (message?.id?.id) return String(message.id.id);
  return null;
}

function registrarMensagemEnviada(message) {
  const id = extrairIdMensagem(message);
  if (!id) return;

  mensagensEnviadasPeloBot.add(id);
  setTimeout(() => mensagensEnviadasPeloBot.delete(id), 10 * 60 * 1000);
}

function foiEnviadaPeloBot(message) {
  const id = extrairIdMensagem(message);
  return id ? mensagensEnviadasPeloBot.has(id) : false;
}

async function enviarTexto(client, user, texto) {
  const message = await client.sendText(user, texto);
  registrarMensagemEnviada(message);
  return message;
}

async function enviarTextoCompatibilidade(client, user, texto) {
  await enviarTexto(client, user, texto);
}

async function enviarTextoComBotoes(client, user, texto, botoes, titulo, rodape) {
  try {
    const message = await client.sendText(user, texto, {
      useTemplateButtons: true,
      buttons: botoes,
      title: titulo,
      footer: rodape,
    });
    registrarMensagemEnviada(message);
    return true;
  } catch (error) {
    console.warn('Nao consegui enviar botoes interativos:', error.message);
    return false;
  }
}

async function enviarListaInterativa(client, user, options, fallbackTexto) {
  try {
    const message = await client.sendListMessage(user, options);
    registrarMensagemEnviada(message);
    return true;
  } catch (error) {
    console.warn('Nao consegui enviar lista interativa:', error.message);
    if (fallbackTexto) {
      await enviarTexto(client, user, fallbackTexto);
    }
    return false;
  }
}

async function enviarMenuPrincipal(client, user, sessionKey) {
  resetarEstado(sessionKey, user);
  const estados = getEstados(sessionKey);
  estados[user].etapa = 'menu';
  const fallbackMenu = 'Ola! Como posso te ajudar?\n1. AGENDAR\n2. PRECOS';

  await enviarListaInterativa(
    client,
    user,
    {
      buttonText: 'Abrir menu',
      description: 'Ola! Escolha uma opcao abaixo para continuar.',
      title: 'Barbearia',
      footer: 'Selecione uma opcao',
      sections: [
        {
          title: 'Atendimento',
          rows: [
            {
              rowId: 'menu_agendar',
              title: 'Agendar horario',
              description: 'Escolher servico, dia e horario',
            },
            {
              rowId: 'menu_precos',
              title: 'Ver precos',
              description: 'Consultar valores de corte e barba',
            },
          ],
        },
      ],
    },
    fallbackMenu
  );

  await enviarTextoCompatibilidade(
    client,
    user,
    `${fallbackMenu}\n\nSe os botoes nao aparecerem, responda com AGENDAR ou PRECOS.`
  );
}

async function enviarPrecos(client, user, servicos, sessionKey) {
  resetarEstado(sessionKey, user);
  const estados = getEstados(sessionKey);
  estados[user].etapa = 'menu';

  await enviarTexto(client, user, `Tabela de precos:\n\n${montarListaPrecos(servicos)}`);

  await enviarListaInterativa(client, user, {
    buttonText: 'Escolher proxima etapa',
    description: 'Agora voce pode agendar seu horario ou voltar ao menu.',
    title: 'Precos da barbearia',
    footer: 'Selecione uma opcao',
    sections: [
      {
        title: 'Atendimento',
        rows: [
          {
            rowId: 'menu_agendar',
            title: 'Agendar horario',
            description: 'Escolher servico, dia e horario',
          },
          {
            rowId: 'menu_voltar',
            title: 'Voltar ao menu',
            description: 'Ver as opcoes iniciais novamente',
          },
        ],
      },
    ],
  });

  await enviarTextoCompatibilidade(
    client,
    user,
    `Tabela de precos em texto:\n\n${montarListaPrecos(servicos)}\n\n1. AGENDAR\n2. MENU`
  );
}

async function enviarListaServicos(client, user, estado, servicos) {
  estado.etapa = 'servico';
  const fallbackTexto = `Qual o servico?\n${montarMenuServicosFallback(servicos)}`;

  const enviado = await enviarListaInterativa(
    client,
    user,
    {
      buttonText: 'Escolher servico',
      description: 'Toque para ver os servicos e os precos antes de agendar.',
      title: 'Qual servico voce quer?',
      footer: 'Selecione uma opcao',
      sections: [
        {
          title: 'Servicos disponiveis',
          rows: servicos.map((servico) => ({
            rowId: `servico:${servico.id}`,
            title: servico.nome,
            description: formatarPreco(servico.preco),
          })),
        },
      ],
    },
    fallbackTexto
  );

  await enviarTextoCompatibilidade(
    client,
    user,
    `${fallbackTexto}\n\nSe a lista nao aparecer no seu celular, responda com o numero ou com o nome do servico.`
  );

  if (!enviado) {
    estado.usandoFallbackTexto = true;
  }
}

async function enviarListaDatas(client, user, estado, configuracaoAgenda, sessionKey) {
  const datas = await buscarDatasDisponiveis(configuracaoAgenda, sessionKey);
  estado.etapa = 'data';
  estado.datasDisponiveis = datas;

  if (!datas.length) {
    await enviarTexto(
      client,
      user,
      'No momento nao temos dias com horarios livres nos proximos 7 dias. Digite Menu para tentar novamente depois.'
    );
    return;
  }

  const fallbackTexto = `Qual o dia?\n${datas.map((item, index) => `${index + 1}. ${item.titulo}`).join('\n')}`;

  const enviado = await enviarListaInterativa(
    client,
    user,
    {
      buttonText: 'Escolher dia',
      description: 'Selecione o melhor dia para voce.',
      title: 'Datas disponiveis',
      footer: 'Escolha uma data',
      sections: [
        {
          title: 'Proximos 7 dias',
          rows: datas.map((item) => ({
            rowId: `data:${item.valor}`,
            title: item.titulo,
            description: item.descricao,
          })),
        },
      ],
    },
    fallbackTexto
  );

  await enviarTextoCompatibilidade(
    client,
    user,
    `${fallbackTexto}\n\nSe a lista nao aparecer no seu celular, responda com o numero do dia ou com o dia escrito.`
  );

  if (!enviado) {
    estado.usandoFallbackTexto = true;
  }
}

async function enviarListaHorarios(client, user, estado) {
  estado.etapa = 'hora';
  const fallbackTexto = `Qual o horario?\n${estado.horariosLivres
    .map((hora, index) => `${index + 1}. ${hora}`)
    .join('\n')}`;

  const enviado = await enviarListaInterativa(
    client,
    user,
    {
      buttonText: 'Escolher horario',
      description: `Horarios livres para ${formatarData(estado.data)}.`,
      title: 'Escolha seu horario',
      footer: 'Toque em um horario',
      sections: [
        {
          title: 'Horarios disponiveis',
          rows: estado.horariosLivres.map((hora) => ({
            rowId: `hora:${hora}`,
            title: hora,
            description: 'Horario disponivel',
          })),
        },
      ],
    },
    fallbackTexto
  );

  await enviarTextoCompatibilidade(
    client,
    user,
    `${fallbackTexto}\n\nSe a lista nao aparecer no seu celular, responda com o numero ou com o horario.`
  );

  if (!enviado) {
    estado.usandoFallbackTexto = true;
  }
}

async function enviarConfirmacao(client, user, estado) {
  estado.etapa = 'confirmar';
  const resumo = montarResumoAgendamento(user, estado);

  const enviado = await enviarTextoComBotoes(
    client,
    user,
    resumo,
    [
      { id: 'confirmar:sim', text: 'Confirmar' },
      { id: 'confirmar:nao', text: 'Cancelar' },
    ],
    'Confirme seu horario',
    'Revise antes de finalizar'
  );

  if (!enviado) {
    await enviarTexto(client, user, `${resumo}\n\nResponda CONFIRMAR ou CANCELAR.`);
    return;
  }

  await enviarTextoCompatibilidade(client, user, `${resumo}\n\n1. CONFIRMAR\n2. CANCELAR`);
}

function encontrarServico(servicos, payload, body) {
  if (String(payload).startsWith('servico:')) {
    const id = Number.parseInt(String(payload).split(':')[1], 10);
    return servicos.find((servico) => Number(servico.id) === id);
  }

  const indice = Number.parseInt(body, 10) - 1;
  if (servicos[indice]) return servicos[indice];

  const textoNormalizado = normalizarTexto(body);
  return servicos.find((servico) => normalizarTexto(servico.nome) === textoNormalizado);
}

function encontrarData(estado, payload, body) {
  if (String(payload).startsWith('data:')) {
    const valor = String(payload).split(':')[1];
    return estado.datasDisponiveis?.find((item) => item.valor === valor);
  }

  const indice = Number.parseInt(body, 10) - 1;
  if (estado.datasDisponiveis?.[indice]) return estado.datasDisponiveis[indice];

  const textoNormalizado = normalizarTexto(body);
  return estado.datasDisponiveis?.find((item) => normalizarTexto(item.titulo) === textoNormalizado);
}

function encontrarHorario(estado, payload, body) {
  if (String(payload).startsWith('hora:')) {
    const hora = String(payload).split(':').slice(1).join(':');
    return estado.horariosLivres?.find((item) => item === hora);
  }

  const indice = Number.parseInt(body, 10) - 1;
  if (estado.horariosLivres?.[indice]) return estado.horariosLivres[indice];

  return estado.horariosLivres?.find((item) => item === body);
}

function ehComandoMenu(normalizado, payload) {
  return ['oi', 'ola', 'menu', 'inicio', 'menu_voltar'].includes(normalizado) || payload === 'menu_voltar';
}

function ehComandoCancelarAgendamento(normalizado) {
  return ['excluir', 'cancelar agendamento', 'cancelar horario', 'desmarcar'].includes(normalizado);
}

function attachBotHandlers(client, options = {}) {
  const sessionKey = options.sessionKey || 'default';
  const assinaturaId = options.assinaturaId || null;
  definirContextoSessao(sessionKey, options);

  client.onMessage(async (message) => {
    if (foiEnviadaPeloBot(message)) return;

    const user = message.from;
    const { body, payload, normalizado } = extrairSelecao(message);
    const estados = getEstados(sessionKey);

    console.log('Mensagem recebida:', {
      sessionKey,
      from: user,
      body,
      payload,
      fromMe: message.fromMe,
      type: message.type,
    });

    if (!estados[user]) {
      resetarEstado(sessionKey, user);
    }

    const estado = estados[user];

    try {
      const acesso = await carregarAcessoAssinatura(assinaturaId, sessionKey);

      if (!acesso.liberado) {
        await enviarTexto(client, user, acesso.mensagem);
        resetarEstado(sessionKey, user);
        return;
      }

      const servicos = await carregarServicos(assinaturaId, sessionKey);
      const configuracaoAgenda = await carregarConfiguracaoAgenda(assinaturaId, sessionKey);

      if (ehComandoMenu(normalizado, payload)) {
        await enviarMenuPrincipal(client, user, sessionKey);
        return;
      }

      if (ehComandoCancelarAgendamento(normalizado) && estado.etapa !== 'confirmar') {
        const agendamentoCancelado = await cancelarAgendamentoDoCliente(user, sessionKey);

        if (!agendamentoCancelado) {
          await enviarTexto(
            client,
            user,
            'Voce nao tem nenhum agendamento confirmado para cancelar agora. Digite MENU para fazer um novo agendamento.'
          );
          return;
        }

        await enviarTexto(
          client,
          user,
          `Seu agendamento foi cancelado com sucesso.\nServico: ${agendamentoCancelado.servico || '-'}\nData: ${new Date(
            `${agendamentoCancelado.data}T00:00:00`
          ).toLocaleDateString('pt-BR')}\nHorario: ${agendamentoCancelado.hora}\n\nQualquer coisa, digite MENU para fazer outro agendamento.`
        );
        resetarEstado(sessionKey, user);
        return;
      }

      if (estado.etapa === 'menu') {
        if (payload === 'menu_agendar' || normalizado === '1' || normalizado === 'agendar') {
          await enviarListaServicos(client, user, estado, servicos);
          return;
        }

        if (payload === 'menu_precos' || normalizado === '2' || normalizado === 'precos') {
          await enviarPrecos(client, user, servicos, sessionKey);
          return;
        }

        await enviarTexto(client, user, 'Nao entendi sua escolha. Digite Menu para abrir as opcoes do atendimento.');
        return;
      }

      if (estado.etapa === 'servico') {
        const servico = encontrarServico(servicos, payload, body);

        if (!servico) {
          await enviarTexto(client, user, 'Nao encontrei esse servico. Digite Menu para abrir as opcoes do atendimento.');
          return;
        }

        estado.servico = servico;
        await enviarListaDatas(client, user, estado, configuracaoAgenda, sessionKey);
        return;
      }

      if (estado.etapa === 'data') {
        const dataSelecionada = encontrarData(estado, payload, body);

        if (!dataSelecionada) {
          await enviarTexto(client, user, 'Nao encontrei essa data. Digite Menu para abrir as opcoes do atendimento.');
          return;
        }

        estado.data = dataSelecionada.valor;
        estado.horariosLivres = await buscarHorariosLivres(estado.data, configuracaoAgenda, sessionKey);

        if (!estado.horariosLivres.length) {
          await enviarTexto(client, user, 'Nao ha horarios livres nesse dia. Vamos escolher outra data.');
          await enviarListaDatas(client, user, estado, configuracaoAgenda, sessionKey);
          return;
        }

        await enviarListaHorarios(client, user, estado);
        return;
      }

      if (estado.etapa === 'hora') {
        const horario = encontrarHorario(estado, payload, body);

        if (!horario) {
          await enviarTexto(client, user, 'Nao encontrei esse horario. Digite Menu para abrir as opcoes do atendimento.');
          return;
        }

        estado.hora = horario;
        await enviarConfirmacao(client, user, estado);
        return;
      }

      if (estado.etapa === 'confirmar') {
        if (payload === 'confirmar:sim' || normalizado === '1' || normalizado === 'confirmar') {
          await salvarAgendamento(user, estado, sessionKey);
          await enviarTexto(
            client,
            user,
            'Obrigado! Seu agendamento foi confirmado com sucesso.\n\nQualquer coisa, digite MENU para fazer outro agendamento ou EXCLUIR se voce quiser cancelar esse horario e marcar outro dia.'
          );
          resetarEstado(sessionKey, user);
          return;
        }

        if (payload === 'confirmar:nao' || normalizado === '2' || normalizado === 'cancelar') {
          await enviarTexto(client, user, 'Tudo bem! Seu agendamento nao foi salvo. Digite Menu para comecar de novo.');
          resetarEstado(sessionKey, user);
          return;
        }

        await enviarTexto(client, user, 'Nao entendi. Digite Menu para abrir as opcoes do atendimento.');
        return;
      }

      await enviarTexto(client, user, 'Digite Menu para abrir as opcoes do atendimento.');
    } catch (error) {
      console.error(`Erro no fluxo do WhatsApp (${sessionKey}):`, error);
      await enviarTexto(
        client,
        user,
        'Tive um problema ao processar sua mensagem. Digite Menu para abrir as opcoes do atendimento.'
      );
      resetarEstado(sessionKey, user);
    }
  });
}

module.exports = {
  attachBotHandlers,
};
