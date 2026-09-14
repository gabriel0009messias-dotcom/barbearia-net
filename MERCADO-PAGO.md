# Pagamentos com Mercado Pago

## Fluxo implementado

Servidor: `backend/app.js` (`npm start`), banco PostgreSQL (schema `salaoflix`). O Checkout Pro cobra o plano cadastrado no servidor. Novos cadastros usam o Plano Profissional de R$ 65 por 30 dias; valores de clientes existentes foram preservados. Cada renovação exige novo pagamento; não foi implementado débito recorrente automático.

1. O cadastro salva a assinatura pendente.
2. O cliente clica em **Pagar com Mercado Pago**. O servidor autentica a conta por senha ou sessão e cria uma preferência de checkout com valor do banco e referência aleatória vinculada à assinatura.
3. O Mercado Pago processa o pagamento. A volta ao site não ativa acesso.
4. O webhook valida `x-signature` com HMAC SHA-256 e consulta `GET /v1/payments/{id}` usando o Access Token do servidor.
5. O backend confere referência, valor, moeda BRL e ambiente. Somente `approved` credita acesso. O registro do pagamento e a ativação ocorrem na mesma transação.
6. A assinatura recebe `status=ativo`, `status_assinatura=ATIVA`, `gateway_status=approved`, `payment_id`, datas de pagamento/vencimento e `bloqueado=0`. A rotina existente de vencimento pode normalizar `ativo` para `ativa`.

Notificações duplicadas não acrescentam dias. Pagamentos pendentes/rejeitados não ativam e não desfazem um período já pago. Estorno ou chargeback do pagamento atual bloqueia a assinatura. Falhas ao consultar a API retornam erro HTTP, permitindo nova tentativa do webhook. Compras de referências externas a este sistema são ignoradas.

O botão de ativação do admin exige o ID de um pagamento aprovado e consulta o provedor. Alterar o status pelo frontend não substitui essa verificação.

## Variáveis no Render

No serviço web, abra **Environment** e cadastre:

| Variável | Valor e origem |
| --- | --- |
| `MERCADO_PAGO_ACCESS_TOKEN` | Mercado Pago Developers → **Suas integrações** → sua aplicação Checkout Pro → **Produção / Credenciais de produção** → **Access Token**. Ative as credenciais de produção, caso solicitado. Para homologação, use as credenciais de teste da aplicação. |
| `MERCADO_PAGO_WEBHOOK_SECRET` | Na mesma aplicação: **Webhooks → Configurar notificação**. Salve a configuração e revele/copie a chave secreta gerada. Use a configuração do ambiente correspondente. Não é o Access Token nem o Client Secret. |
| `MERCADO_PAGO_MODE` | `production` para pagamentos reais; `test` para homologação. Valor definido por você, não é uma credencial. |
| `PUBLIC_APP_URL` | `https://barbearia-net.onrender.com`, se esse continuar sendo o domínio do serviço. Sem barra no final. A origem é o endereço público do Render. |

Configure `DATABASE_URL` com a URL do PostgreSQL. Nao e necessario disco persistente no Web Service. Consulte [POSTGRESQL-RENDER.md](POSTGRESQL-RENDER.md).

Este fluxo não precisa de **Public Key**, **Client ID**, **Client Secret**, `MP_ACCESS_TOKEN` nem de uma URL base alternativa da API. As credenciais ficam somente no backend; não adicione variáveis `VITE_` com segredos.

Fontes oficiais: [credenciais](https://www.mercadopago.com.br/developers/pt/docs/credentials), [configuração de notificações](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/payment-notifications).

## Webhook

Cadastre a URL abaixo na aplicação do Mercado Pago, selecionando o evento **Pagamentos / payment**:

```text
https://barbearia-net.onrender.com/api/mercadopago/webhook
```

Se mudar o domínio, atualize tanto a URL do webhook quanto `PUBLIC_APP_URL`. O backend também envia essa URL ao criar cada preferência. Não acrescente o segredo à URL. A autenticação utiliza os headers `x-signature`, `x-request-id` e o parâmetro `data.id` enviado pelo Mercado Pago.

Depois de salvar as variaveis e publicar o codigo, confira `/api/health`. As migrations PostgreSQL sao automaticas na inicializacao ou executadas com `npm run migrate`.

## Como testar

1. Use um serviço de homologação com banco separado. Configure `MERCADO_PAGO_MODE=test`, Access Token de teste, segredo de webhook e `PUBLIC_APP_URL` da homologação. Não misture credenciais ou pagamentos de teste com produção.
2. Em **Suas integrações → sua aplicação → Contas de teste**, utilize o comprador de teste. Faça a compra em janela anônima, sem estar logado como vendedor. Use os cartões e cenários fornecidos pela documentação oficial, inclusive o cenário aprovado.
3. No site, cadastre uma conta e confirme que o acesso continua pendente. Clique no botão para pagar. Confira que o checkout apresenta o valor correto.
4. Faça uma compra aprovada e anote o ID do pagamento. A documentação informa que pagamentos feitos com credenciais de teste podem não enviar notificações; use o simulador em Webhooks para testar a entrega. Um ID fictício sem pagamento correspondente não deve ativar uma conta.
5. Para verificar um pagamento de teste existente, execute localmente na pasta `backend` com a External Database URL em `DATABASE_URL` (o plano Free nao oferece Shell):

```sh
npm run payments:verify -- ID_PAGAMENTO ID_ASSINATURA
```

O comando consulta o Mercado Pago, confere que o pagamento pertence à assinatura informada e aplica a mesma ativação usada pelo webhook. Não aceita confirmação fictícia nem pagamento pendente. Também pode ser usado para recuperar uma confirmação perdida em produção, com os IDs corretos.

6. Confira o banco e faça login. Execute a verificação novamente: o vencimento não deve avançar pela segunda vez. Teste também pagamento pendente/rejeitado, que deve manter o cadastro sem acesso.
7. Para atestar o webhook real de produção, após configurar credenciais reais e publicar o código, realize uma compra real controlada. Confira a entrega HTTP 200 no histórico de Webhooks, `approved` no Mercado Pago e a assinatura no banco. Esse pagamento real não foi executado durante a alteração do código.

Fontes oficiais: [compras de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/integration-test/test-purchases), [contas de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/test-accounts), [notificações](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/payment-notifications).

## Como confirmar no banco

Conecte ao PostgreSQL de `DATABASE_URL` e execute `SET search_path TO salaoflix, public;` antes das consultas abaixo, substituindo o email:

```sql
SELECT id, email, status, status_assinatura, gateway_provider,
       gateway_status, payment_id, ultimo_pagamento,
       proximo_vencimento, bloqueado
FROM assinaturas
WHERE email = 'EMAIL_DO_CLIENTE';
```

Logo após a aprovação, espere `ativo` ou `ativa`, `ATIVA`, `mercado_pago`, `approved`, `payment_id` preenchido, `bloqueado=0` e vencimento futuro.

```sql
SELECT payment_id, assinatura_id, status, amount_cents, credited_at
FROM mercado_pago_payments
WHERE assinatura_id = ID_ASSINATURA;
```

O pagamento creditado deve ter `status=approved`, valor em centavos correspondente ao plano e `credited_at` preenchido. Em `mercado_pago_orders`, a referência deve apontar para a mesma assinatura e `credited_payment_id` deve ser esse pagamento.

Sem um cliente SQL instalado, o comando `npm run payments:verify` acima também imprime os campos da assinatura diretamente do banco após a consulta ao provedor.

## Arquivos deste trabalho

Alterados:

- `README.md`, `render.yaml`;
- `backend/.env.example`, `backend/AUDIT.md`, `backend/app.js`, `backend/database.js`, `backend/package.json`, `backend/routes.js`;
- `backend/src/services/mercadoPagoService.js` (validação da assinatura compartilhada com a base alternativa);
- `painel/index.html`, `painel/landing.js`, `painel/cadastro.html`, `painel/cadastro.js`;
- `painel/barbeiro.html`, `painel/barbeiro.js`, `painel/controle-interno.html`, `painel/controle-interno.js`, `painel/pagamento-pix.html`.

Criados:

- `MERCADO-PAGO.md`;
- `backend/services/payments/mercadoPago.js`, `backend/services/payments/signature.js`;
- `backend/scripts/verify-mercado-pago.js`;
- `backend/test/payments.test.js`, `backend/test/startup.test.js`.

Removidos: o módulo do provedor anterior, `backend/webhook.js` e três backups antigos de `app.js`, `routes.js` e `README.md` em `.codex/backups/`. A lista nominal completa de remoções está no diff do Git. O banco existente e seu histórico foram preservados; não houve remoção de tabelas ou dados de clientes.

Não havia SDK exclusivo do provedor anterior no `package.json`. `axios` continua necessário na base alternativa do Mercado Pago. A busca em arquivos textuais e no histórico Git acessível não encontrou credenciais com os formatos pesquisados de Access Token do Mercado Pago; isso não substitui a revogação de qualquer credencial que tenha sido compartilhada por outros meios.

## Limites da validação

Os testes automatizados consultam um provedor simulado e bancos temporários. A inicialização real de `backend/app.js` também é testada sem credenciais. Não houve deploy, alteração das variáveis remotas, cobrança real ou validação com conta Mercado Pago durante este trabalho. As configurações no painel das plataformas e a compra final descrita acima ainda são necessárias.
