const axios = require('axios');

const asaas = axios.create({
  baseURL: 'https://api-sandbox.asaas.com/v3',
  headers: {
    access_token:
      '$aact_hmlg_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjcyYjRkNmZlLWVmN2EtNDNmYS1iMzZkLWY0ZDI2MjI3YmU0Mzo6JGFhY2hfODgxYmVlZjAtMjBkOC00YzdhLWFiMjktMmE0N2I2OTIxZWIx',
    'Content-Type': 'application/json',
  },
});

module.exports = asaas;
