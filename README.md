# Salaoflix - sistema de barbearias

O servidor iniciado por `npm start` e pelo Render e `backend/app.js`, com Express, PostgreSQL e as paginas HTML/JavaScript em `painel/`.

Os arquivos em `backend/src/` e `painel/src/` pertencem a uma base alternativa com PostgreSQL/React. O fluxo de pagamentos documentado aqui usa o servidor atual; nao troque o comando de inicializacao.

## Pagamentos

O unico provedor de cobranca e Mercado Pago, via Checkout Pro. O cadastro cria uma assinatura pendente; o checkout cobra o valor registrado no banco (R$ 65 para novos cadastros). Uma confirmacao autenticada consulta o pagamento no Mercado Pago antes de liberar 30 dias de acesso. Nao ha debito recorrente automatico: cada renovacao e paga pelo checkout.

Veja [MERCADO-PAGO.md](MERCADO-PAGO.md) para variaveis do Render, webhook, testes e consultas ao banco.

## Executar

Na pasta backend:

```sh
npm install
npm start
```

Configure DATABASE_URL e abra http://localhost:3000. As migrations PostgreSQL sao aplicadas na inicializacao ou com `npm run migrate`. Consulte [POSTGRESQL-RENDER.md](POSTGRESQL-RENDER.md) para importar o SQLite local sem altera-lo.

Para pagamentos, configure um endereco HTTPS publico em PUBLIC_APP_URL e as credenciais descritas no guia. Sem elas, o servidor inicia, mas nao gera checkout.

## Testes

```sh
cd backend
npm test
```

Defina TEST_DATABASE_URL para um PostgreSQL exclusivo de testes. Cada suite cria e remove somente seu schema temporario.

No PowerShell com scripts bloqueados, use `npm.cmd test`. Os testes usam bancos temporarios e APIs simuladas, sem cobrar ou enviar mensagens reais.

## Render e persistencia

O `render.yaml` instala o backend e executa `npm start`, servindo tambem as paginas de `painel/`. Configure DATABASE_URL com a Internal Database URL do PostgreSQL na mesma regiao. Nao e necessario disco persistente no Web Service. O SQLite local foi preservado e serve como origem de importacao. Veja [POSTGRESQL-RENDER.md](POSTGRESQL-RENDER.md).

## WhatsApp

O funcionamento do atendimento esta documentado em [WHATSAPP-AGENDAMENTO.md](WHATSAPP-AGENDAMENTO.md). Suas configuracoes e credenciais sao independentes das de pagamento.
