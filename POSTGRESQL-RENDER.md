# PostgreSQL no Render

## O que foi migrado

O servidor continua sendo `backend/app.js` e o painel fica em `backend/public/`, dentro do Root Directory publicado no Render. Agora todos os acessos desse servidor usam `pg` e `DATABASE_URL`. Não existe fallback operacional para SQLite, nem necessidade de disco no Web Service.

O schema padrão é **salaoflix**. Ele separa as tabelas do sistema atual das tabelas da base alternativa em `backend/src`, que usa outro modelo de dados. Não execute as migrations dessa base alternativa para este sistema. O comando `npm run migrate` foi atualizado para o backend atual.

Foram preservados:

- `clientes`, `servicos`, `agendamentos`, `bloqueios` e `servicos_assinatura`;
- os **55 campos de assinaturas**, incluindo dados do salão/barbeiro, senha/salt, plano, acesso, vencimento, WhatsApp e Mercado Pago;
- `configuracoes`, `password_reset_tokens`, `sessoes`, `whatsapp_messages`;
- `mercado_pago_orders` e `mercado_pago_payments`;
- `clientes_saas`, tabela histórica existente no arquivo local, sem reativar o provedor antigo.

O login dos barbeiros usa `assinaturas`; o admin continua usando suas credenciais de ambiente. Não foi inventada uma tabela de usuários diferente da utilizada pelo sistema. Datas permanecem em texto para manter o formato esperado pelas telas; valores monetários mantêm o comportamento existente. IDs e índices de agendamento e de idempotência foram preservados. A tabela local de clientes já permite telefones repetidos: a importação conserva esses registros, sem excluir ou mesclar pessoas.

Migrations usam transação, lock e histórico com checksum. Não apagam tabelas nem recriam dados a cada deploy. Seeds usam `ON CONFLICT` e não sobrescrevem configurações existentes. Transações do atendimento e dos pagamentos usam uma conexão reservada e lock PostgreSQL, preservando a proteção contra concorrência.

## Criar o banco no Render

1. No Dashboard, escolha **New → Postgres**.
2. Escolha nome, banco, usuário e a **mesma região e conta do Web Service**.
3. Selecione o plano desejado e aguarde o banco ficar disponível.
4. Abra **Connect** na página do banco (também disponível em **Info / Connections**).
5. Copie **Internal Database URL** para o Web Service no Render. Use **External Database URL** para comandos no seu computador, importação e ferramentas como DBeaver/psql.

As URLs internas são destinadas a serviços Render da mesma região; a externa é para acessos de fora. O driver aplica TLS com validação do certificado aos hosts externos Render quando a URL não define suas próprias opções SSL. A URL interna funciona pela rede privada. Opções `sslmode` explícitas da URL são respeitadas. [Documentação oficial de conexão](https://render.com/docs/postgresql-creating-connecting).

**Limite do plano gratuito:** o PostgreSQL Free do Render expira em **30 dias**, não oferece backups gerenciados e não é uma solução gratuita permanente. O Web Service Free não oferece Shell. Planeje continuidade e exportação dos dados antes da expiração. [Limites oficiais](https://render.com/docs/free).

## Importar o SQLite local sem alterá-lo

Use um destino novo, antes de permitir cadastros no novo backend. Pare as gravações no sistema antigo durante a transferência final, para evitar que novos registros fiquem fora da cópia.

Na pasta `backend`, configure `DATABASE_URL` com a **External Database URL**. Pode usar seu `.env` local, que não é versionado. No PowerShell, alternativamente:

```powershell
$env:DATABASE_URL = 'COLE_A_EXTERNAL_DATABASE_URL'
npm.cmd run migrate
npm.cmd run db:import-sqlite -- ./barbearia.db --check
npm.cmd run db:import-sqlite -- ./barbearia.db
```

O importador abre a origem com **OPEN_READONLY**, lê um snapshot, preserva IDs/campos, verifica os valores no destino, ajusta sequences e confirma tudo em uma única transação. `--check` executa o ensaio e reverte as linhas importadas; as migrations e seeds iniciais permanecem no destino. Repetir a mesma importação não duplica registros nem sobrescreve alterações posteriores no PostgreSQL.

O importador recusa um destino que já tenha dados de operação. Também recusa tabelas/campos desconhecidos ou inconsistências de relacionamento, em vez de omitir registros. Se falhar, as linhas importadas são revertidas e o SQLite permanece intacto. Não use o importador para mesclar dois sistemas em atividade.

O ensaio local do arquivo deste projeto conferiu **36 registros de 10 tabelas**, incluindo os campos de pagamento, sem alterar o arquivo original. Não foi feita importação em um banco remoto.

## Configurar o Web Service

Cadastre em **Environment**:

```env
DATABASE_URL=INTERNAL_DATABASE_URL_DO_RENDER
MERCADO_PAGO_ACCESS_TOKEN=SEU_ACCESS_TOKEN
MERCADO_PAGO_WEBHOOK_SECRET=SUA_CHAVE_DO_WEBHOOK
MERCADO_PAGO_MODE=production
PUBLIC_APP_URL=https://barbearia-net.onrender.com
```

Mantenha as variáveis existentes de admin, e-mail e Evolution. A migração não substitui essas configurações. `DATABASE_SCHEMA` é opcional e tem padrão `salaoflix`; se alterá-lo, use o mesmo valor no importador e no Web Service.

Remova a variável antiga de caminho de arquivo e a configuração de disco persistente do serviço. O `render.yaml` já foi preparado para usar o plano Free sem disco; a alteração local do arquivo não muda automaticamente o serviço publicado.

| Configuração | Valor |
| --- | --- |
| Root Directory | `backend` |
| Build Command | `PUPPETEER_SKIP_DOWNLOAD=true npm ci` |
| Start Command | `npm start` |
| Migrations manuais | `npm run migrate` |

O Start Command aguarda a conexão e as migrations antes de aceitar requisições. Assim, não depende de Shell ou de um comando de pré-deploy do plano pago. Para rodar migrations manualmente no Free, use seu computador com a External Database URL.

## Confirmar conexão e funcionamento

Espere estes logs:

```text
[database] Migration aplicada: 001_current_backend.sql
[database] PostgreSQL conectado; migrations em dia (schema salaoflix).
Servidor rodando na porta ...
```

A primeira linha aparece somente quando a migration é nova. Se não houver conexão/migrations concluídas, o servidor não deve abrir a porta HTTP. Verifique também `/api/health`.

No cliente PostgreSQL:

```sql
SELECT name, applied_at FROM salaoflix.schema_migrations;
SELECT id, email, status, status_assinatura, gateway_status,
       payment_id, bloqueado, ultimo_pagamento, proximo_vencimento
FROM salaoflix.assinaturas;
SELECT payment_id, assinatura_id, status, credited_at
FROM salaoflix.mercado_pago_payments;
```

O webhook continua sendo `https://barbearia-net.onrender.com/api/mercadopago/webhook`. Continua validando a assinatura HMAC, consultando o pagamento na API, conferindo valor/moeda/ambiente e concedendo 30 dias somente após `approved`. Pagamentos importados e notificações duplicadas não acrescentam um segundo período. Consulte [MERCADO-PAGO.md](MERCADO-PAGO.md).

Depois da publicação feita por você: confira cadastro, login, agenda, painel, bloqueios, conexão WhatsApp e uma compra de homologação. O Web Service Free pode ficar inativo; isso pode atrasar a primeira resposta do webhook. [Comportamento do plano Free](https://render.com/docs/free).

## Testes locais

Crie um PostgreSQL exclusivo para testes. Não use o banco dos clientes:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://USUARIO:SENHA@localhost:5432/barbearia_test'
cd backend
npm.cmd test
```

As suites usam PostgreSQL real, com schemas temporários exclusivos. A limpeza remove somente os schemas criados pelos testes. As APIs externas são simuladas. SQLite é usado somente para construir a origem do teste de importação; não é utilizado pelos testes operacionais do backend.

## Arquivos desta migração

Criados:

- `backend/database/config.js`, `backend/database/postgres.js`, `backend/database/migrate.js`;
- `backend/database/migrations/001_current_backend.sql`;
- `backend/scripts/migrate-postgres.js`, `backend/scripts/import-sqlite.js`;
- `backend/test/helpers/postgres.js`, `backend/test/migration.test.js`;
- `POSTGRESQL-RENDER.md`.

Alterados:

- `.gitignore`, `render.yaml`, `backend/.env.example`, `backend/package.json`;
- `backend/database.js`, `backend/app.js`, `backend/routes.js`, `backend/botFlow.js`, `backend/whatsappWebhook.js`, `backend/evolutionWebhook.js`;
- `backend/services/whatsapp/sessionRepository.js`, `backend/services/whatsapp/scheduling.js`, `backend/services/payments/mercadoPago.js`;
- `backend/scripts/verify-mercado-pago.js`;
- `backend/test/database-path.test.js`, `backend/test/chatbot.test.js`, `backend/test/whatsapp.test.js`, `backend/test/payments.test.js`, `backend/test/startup.test.js`;
- `README.md`, `MERCADO-PAGO.md`, `WHATSAPP-AGENDAMENTO.md`, `WHATSAPP-CONEXAO.md`, `backend/AUDIT.md`.

Dependências: `pg` já estava instalado e agora é o driver operacional. Nenhuma dependência nova foi necessária. `sqlite3` foi mantido apenas para importação local e seu teste. Não é carregado pelo servidor.

Nenhum deploy ou cobrança real foi feito. O banco SQLite local não foi apagado nem alterado.

Validacao final: **71 testes aprovados, zero falhas**, em PostgreSQL local real. Inclui inicializacao do servidor, cadastro/login, consultas do painel, agenda, WhatsApp, checkout/webhook, concorrencia, migrations e importacao. O SHA-256 do arquivo SQLite original permaneceu identico antes e depois do trabalho.
