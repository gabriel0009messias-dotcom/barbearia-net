# Diagnostico do Checkout Pro — 15/09/2026

## Conclusao ate o momento

Nao foi possivel comprovar a causa dos botoes cinza apenas pelo codigo e pelo registro da preferencia. Nao ha evidencia para atribuir o problema a `unit_price`, Pix ou `auto_return`. A resposta privada da preferencia e o estado da conta vendedora ainda precisam ser consultados pelo administrador. A sessao do comprador dentro do Mercado Pago tambem nao foi inspecionada.

Nao foi realizado pagamento, criada preferencia de teste nem alterado dado do PostgreSQL de producao. A consulta SQL foi executada em uma transacao `READ ONLY`. Os testes usam PostgreSQL descartavel e API simulada.

## Evidencias verificadas

- A unica preferencia registrada na consulta tinha valor de 6500 centavos, `live_mode=1` no registro local, URL `www.mercadopago.com.br` e nenhum pagamento creditado nesse pedido.
- A preferencia foi criada em 15/09/2026 e vence em 16/09/2026 as 13:16:55 UTC. Ainda estava dentro do prazo durante a analise.
- O HTML publico do checkout retornou HTTP 200 e indicou `productive: true`. Isso comprova o caminho de producao utilizado pelo checkout, mas nao substitui a verificacao privada das credenciais e da conta.
- O e-mail do cadastro usado nessa preferencia e o da conta de teste indicada pelo proprietario. Nao foi comprovado se esse e-mail tambem pertence ao recebedor no Mercado Pago ou se o navegador esta autenticado como vendedor.
- O GET privado da preferencia sem Access Token retornou HTTP 400. Isso e esperado para uma consulta sem autenticacao; nao e a resposta original da criacao.
- A resposta completa do POST original nao era persistida nem registrada pelo projeto. Nao e possivel reconstruir retroativamente esse log. O novo diagnostico consulta a preferencia existente, sem recria-la.

## Comparacao do payload com a documentacao

| Campo | Implementacao atual | Resultado da revisao |
| --- | --- | --- |
| Credenciais / ambiente | Access Token no header do backend; `production` seleciona `init_point`, `test` seleciona `sandbox_init_point` | A origem de producao foi observada. A credencial remota e as restricoes da conta exigem consulta autenticada. O prefixo do token isoladamente nao comprova o ambiente. |
| `items` | Um item, titulo do plano com 30 dias | Formato compativel com a API de preferencias. |
| `unit_price` | Numero 65, calculado a partir do contrato no banco | Correto para o pedido analisado. |
| `quantity` / `currency_id` | `1` / `BRL` | Compativeis com R$ 65. |
| `payer` | Apenas `email`, vindo do cadastro | Campo opcional aceito pela API. Nao foi inventado CPF nem outro dado do comprador. Comparar o comprador com o recebedor e verificar os campos exigidos pelo checkout. |
| `payment_methods` | Nao enviado | Nao exclui Pix ou cartao. A documentacao informa disponibilidade padrao dos meios; nao ha necessidade de inserir listas vazias para habilita-los. |
| `back_urls` | HTTPS, mesma pagina do cadastro para success/pending/failure | As tres URLs sao enviadas. Nao ativam acesso nem confirmam pagamento. |
| `auto_return` | `approved` | Valor documentado para retorno apos aprovacao. |
| `notification_url` | HTTPS, `/api/mercadopago/webhook` | Formato compativel. Segredo nao aparece na URL. A entrega/autenticidade do webhook nao foi testada contra um pagamento real. |
| `external_reference` | UUID unico ligado ao pedido | Usado para associar a confirmacao a assinatura. |
| Expiracao | `expires: true`, 24 horas | A preferencia examinada nao estava expirada. |

## Alteracoes realizadas

- `backend/services/payments/mercadoPago.js`: passa a registrar HTTP status, request ID e corpos JSON da criacao de preferencia com dados sensiveis ocultos. O payload e a regra de pagamento permanecem iguais.
- `backend/services/payments/diagnostics.js`: sanitizacao dos dados e consultas GET da preferencia existente, do titular da credencial e dos meios de pagamento.
- `backend/routes.js`: endpoint administrativo `GET /api/admin/mercadopago/diagnostico/:preferenceId`. Exige sessao de administrador, aceita apenas preferencias registradas no sistema e responde com `Cache-Control: no-store`.
- `backend/test/payments.test.js`: confere campos do payload, autenticacao do diagnostico, ausencia de alteracoes no banco e ocultacao dos dados sensiveis.
- `backend/test/payment-diagnostics.test.js`: confere ocultacao de credenciais/dados pessoais e preservacao de HTTP status e request ID em erros da API.
- Este relatorio.

O diagnostico compara o e-mail do comprador com o titular da credencial dentro do servidor e devolve apenas o resultado booleano. Nunca devolve o Access Token ou segredo do webhook. A resposta da preferencia preserva os campos tecnicos, com campos sensiveis substituidos por `[REDACTED]`.

## Validacao e pendencia

118 testes passaram antes do push do codigo (`d4bf4af`). Nenhuma mudanca no valor do plano, no pagamento, na preferencia existente ou nas credenciais foi aplicada.

A consulta administrativa remota ficou pendente de autorizacao explicita: a revisao automatica nao aceitou reutilizar no endpoint de administrador as credenciais antes informadas para login do salao. Sem essa consulta ou evidencia equivalente fornecida pelo proprietario, nao se deve declarar que o bloqueio e causado por conta vendedora, mistura de ambientes ou autopagamento.

## Fontes oficiais consultadas

- [Criar preferencia](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-pro-preferences/create-preference/post): campos e erros, inclusive requisitos regulatorios do vendedor.
- [Consultar preferencia existente](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-pro-preferences/get-preference/get).
- [Meios de pagamento](https://www.mercadopago.com.br/developers/en/docs/checkout-pro-preferences/additional-settings/payment-methods): meios disponiveis por padrao e exclusoes opcionais.
- [Contas de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/test-accounts): comprador e vendedor separados; credenciais de teste do Checkout Pro tambem podem iniciar com `APP_USR`.
- [Compras de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/integration-test/test-purchases): janela anonima para evitar conflito de credenciais e preenchimento dos campos exigidos.
- [Credenciais](https://www.mercadopago.com.br/developers/en/docs/your-integrations/credentials): autenticacao no header e consulta `/users/me`.
