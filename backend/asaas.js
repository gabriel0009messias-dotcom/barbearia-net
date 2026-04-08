const axios = require('axios');

const asaas = axios.create({
  baseURL: 'https://api.asaas.com/v3',
  headers: {
    access_token:
      '$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjM5NTViOWVkLTdlYzgtNGJkNy04NjU1LWQ3MTI3OTJlMTlhNjo6JGFhY2hfMTJhMTY3MWEtNjE2Mi00OTBlLWIwOTMtNWU5MjVjOGQ4MzE3',
    'Content-Type': 'application/json',
  },
});

async function criarCliente({ nome, cpf, email, telefone }) {
  const response = await asaas.post('/customers', {
    name: nome,
    cpfCnpj: cpf,
    email,
    mobilePhone: telefone,
  });

  return response.data;
}

async function criarAssinatura({ customer, nextDueDate, value = 65 }) {
  const response = await asaas.post('/subscriptions', {
    customer,
    billingType: 'PIX',
    value,
    cycle: 'MONTHLY',
    nextDueDate,
  });

  return response.data;
}

module.exports = asaas;
module.exports.criarCliente = criarCliente;
module.exports.criarAssinatura = criarAssinatura;
