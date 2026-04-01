const express = require('express');
const path = require('path');
const crypto = require('crypto');

const asaas = require('./asaas');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const painelPath = path.join(__dirname, '..', 'painel');
const assinaturasCadastradas = [];
const barbeiroSessions = new Map();
const ACESSO_VITALICIO = {
  id: 1,
  email: 'gabriel0009messias@gmail.com',
  senha: 'rios123456',
  barbeariaNome: 'Salao Demo',
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

app.get('/api/publico/assinatura-config', (req, res) => {
  res.json({
    suporteNumero: '--',
    valorMensal: 65,
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
    whatsappBridgeUrl: 'http://127.0.0.1:3010',
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

app.get('/api/agendamentos', requireBarbeiro, (req, res) => {
  res.json(demoAgendamentos);
});

app.get('/api/faturamento', requireBarbeiro, (req, res) => {
  res.json({ total: 0 });
});

app.get('/api/bloqueios', requireBarbeiro, (req, res) => {
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

app.get('/api/publico/assinaturas/:id', requireBarbeiro, (req, res) => {
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

app.post('/api/publico/assinaturas/:id/whatsapp/bridge-token', requireBarbeiro, (req, res) => {
  res.json({ token: 'demo-bridge-token' });
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
        value: 65,
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
        value: 65,
        dueDate: nextDueDate,
        description: `Assinatura Salaoflix - ${barbeariaNome}`,
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
        value: 65,
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
      value: 65,
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
