# Studiofy 2B — validação final local

## Banco utilizado

Foi encontrado PostgreSQL 18 instalado, com um serviço local em execução, mas sem `TEST_DATABASE_URL` ou credenciais de testes disponíveis. O serviço existente não foi usado nem reconfigurado.

Foi inicializado um cluster novo e separado com os binários instalados:

- PostgreSQL 18.6, escutando somente em `127.0.0.1:55432`.
- Dados: `C:\Users\User\Desktop\barbearia\.tmp\trial-validation-pg\data`.
- Banco criado: `studiofy_test`.
- Papel criado para a suíte: `studiofy_runner`, proprietário desse banco, sem SUPERUSER, CREATEDB ou CREATEROLE.
- A variável de conexão de testes foi definida apenas nos processos locais, sem incluir URL configurada no repositório.
- Autenticação local `trust` para este cluster temporário, sem senha ou credenciais de produção. A instância não é destinada a publicação.

`SHOW data_directory` confirmou o diretório isolado antes da criação do banco. Os testes criaram e removeram seus próprios schemas `test_<uuid>`. `.env` não foi alterado. Nenhum teste foi dirigido ao banco de produção.

Ao terminar, a consulta de schemas de teste retornou zero e esta instância temporária foi parada via `pg_ctl` com seu diretório explícito. O serviço local `postgresql-x64-18` continuou em execução, sem alterações. Os arquivos do cluster foram mantidos em `.tmp` para eventual repetição local; a URL só funciona quando essa instância for iniciada novamente na porta 55432.

## Migration 008

Revisada e executada somente no cluster de testes. Não foi necessário alterar seu conteúdo.

- Dois `ADD COLUMN IF NOT EXISTS` e um `CREATE TABLE IF NOT EXISTS`.
- Nenhum DROP, DELETE, TRUNCATE, UPDATE ou backfill.
- `trial_status` e `trial_ends_at` ficam NULL para contas existentes.
- Campos legados, assinaturas, pagamentos e reservas existentes permanecem preservados.
- Compatível com a ordem 001–008, transação, advisory lock e verificação SHA-256 do migrador atual.
- Testes de upgrade, migrations concorrentes/repetidas e preservação de dados executados com PostgreSQL real.

SHA-256 revisado: `23d70ab8b0f38d4980a19e0b330dfb5e32db30eaef3991724098ae5d575c0f3a`.

## Por que evolutionWebhook.js mudou

Este arquivo processa mensagens recebidas da Evolution e envia respostas automáticas com o link de agendamento. Ele também drena uma fila persistente. Essas operações não passam pelos middlewares HTTP do painel. Sem a checagem adicional, uma conta com trial expirado poderia continuar usando respostas automáticas mesmo com as rotas operacionais bloqueadas.

A alteração foi mantida por ser necessária à autorização de trial/assinatura:

1. Antes de criar uma resposta, consulta a autorização central do estabelecimento identificado pela instância.
2. Antes de enviar uma resposta já enfileirada, consulta novamente a autorização.
3. Sem acesso, preserva a resposta como `pending` e adia nova consulta por cinco minutos. O worker existente consulta a fila a cada 15 segundos; após pagamento, essa resposta pode aguardar o prazo restante mais um ciclo do worker. O acesso ao painel/API é liberado na próxima requisição.

Durante esta revisão, o incremento de `attempts` foi movido para imediatamente antes do envio autorizado. Assim, aguardar regularização não conta como falha do provedor e não aumenta seu backoff. Um teste verifica esse comportamento, a preservação do texto, a rejeição de novas respostas durante a expiração e o envio após liberação.

Não foram modificados conexão de instância, geração/leitura de QR Code, pairing code, conteúdo das mensagens, extração de eventos, autenticação do webhook, deduplicação, transporte HTTP, tratamento de 429, `Retry-After` ou cooldown de conexão. A fórmula existente de retry por falha de envio permanece `min(300000, 10000 * (attempts + 1))`. A espera por assinatura é uma decisão de autorização separada dessa fórmula.

Lembretes não são enviados por este arquivo: ficam em `services/reminders.js`. A regra já incluída na 2B impede envio sem acesso e preserva o registro como cancelado; agenda e dados do cliente não são apagados. Os testes de lembretes, cancelamento, concorrência e entrega incerta integram a regressão.

## Segurança e fluxo

Testes com backend e PostgreSQL reais cobrem cadastro e duração exata de 168 horas, login durante/depois do trial, acesso operacional, logout/login sem reinício, isolamento entre estabelecimentos, rejeição de datas enviadas pelo cliente, preservação de serviços/reservas, planos e checkout após expiração, contas antigas e assinatura ativa.

Um teste adicional executa um navegador real que altera JavaScript, localStorage e o relógio para 1999, inventa um trial até 2099 e envia requisições diretamente ao backend. Resultado esperado e verificado: edição e operação retornam 403, consulta da conta retorna 200 com `trial_expired`, e o término armazenado não muda.

O teste de Mercado Pago expira o trial, comprova bloqueio operacional, processa a aprovação pelo webhook existente e comprova liberação usando a mesma sessão. Chamadas externas ao Mercado Pago/Evolution são simuladas pelos testes; não houve cobrança real ou envio real de WhatsApp.

## Correção encontrada pela regressão PostgreSQL

O importador SQLite anterior à 2B rejeitava o catálogo `business_types` criado pela migration 007 como se fosse dado de um sistema em operação. Isso bloqueava o teste de importação mesmo em banco novo.

Foi corrigido apenas o reconhecimento dos valores padrão exatos desse catálogo. Dados personalizados continuam impedindo importação; um teste altera o catálogo e comprova a rejeição sem sobrescrita. Nenhuma migration aplicada foi reescrita. A importação foi executada apenas sobre fixtures e schemas de teste.

## Evidências

- Primeira execução dos grupos PostgreSQL: 109 aprovados, 5 falhas (quatro subtestes de importação e seu teste pai), zero ignorados.
- Após a correção e os novos testes de segurança/fila: 12 aprovados, zero falhas, zero ignorados nos testes focados.
- **Suíte completa final: 231 aprovados / 0 falhas / 0 ignorados**, em 45,67 segundos, com código de saída 0. Inclui todos os 14 grupos anteriormente bloqueados e os dois testes antes ignorados por falta de banco.
- Comando: `npm.cmd test` em `backend`, com `TEST_DATABASE_URL` da instância isolada. `git diff --check` passou.
- Logs: `.tmp/trial-validation-pg/integration.log`, `focused.log` e `full-suite.log`.

Não foram feitos commit, push, deploy, aplicação em produção ou trabalho na 2C. Publicação somente da 2B autorizada pelo usuário em 25/09/2026, após esta validação.
