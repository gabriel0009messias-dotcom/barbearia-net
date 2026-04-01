const express = require('express');
const path = require('path');

const asaas = require('./asaas');

const app = express();
const PORT = 3000;
const painelPath = path.join(__dirname, '..', 'painel');

app.use(express.json());
app.use(express.static(painelPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(painelPath, 'index.html'));
});

app.get('/cadastro.html', (req, res) => {
  res.sendFile(path.join(painelPath, 'cadastro.html'));
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
    const response = await asaas.post('/customers', {
      name: nome,
      cpfCnpj: cpf,
      email,
      mobilePhone: telefone,
      phone: telefone,
    });

    res.status(201).json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json(
      error.response?.data || {
        error: 'Erro ao criar cliente no Asaas',
      }
    );
  }
});

app.post('/criar-assinatura', async (req, res) => {
  const { customerId, diaVencimento } = req.body;
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

  const nextDueDate = `${ano}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

  try {
    const response = await asaas.post('/subscriptions', {
      customer: customerId,
      billingType: 'PIX',
      value: 65,
      cycle: 'MONTHLY',
      nextDueDate,
    });

    res.status(201).json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json(
      error.response?.data || {
        error: 'Erro ao criar assinatura no Asaas',
      }
    );
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

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
