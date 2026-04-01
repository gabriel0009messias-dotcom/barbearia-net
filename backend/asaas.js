const axios = require('axios');

const asaas = axios.create({
  baseURL: 'https://api.asaas.com/v3',
  headers: {
    access_token:
      '$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjM5NTViOWVkLTdlYzgtNGJkNy04NjU1LWQ3MTI3OTJlMTlhNjo6JGFhY2hfMTJhMTY3MWEtNjE2Mi00OTBlLWIwOTMtNWU5MjVjOGQ4MzE3',
    'Content-Type': 'application/json',
  },
});

module.exports = asaas;
