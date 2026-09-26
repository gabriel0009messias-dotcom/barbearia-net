# Etapa 2C.4 — fechamento da validação local

Validação retomada em 26/09/2026. Sem commit, push, deploy ou aplicação da migration em produção. A 2C não foi publicada.

## Resultado

- Testes específicos: **19 aprovados / 0 falharam / 0 ignorados**, conforme estado confirmado na retomada. Não houve execução específica adicional; esses testes também fazem parte da suíte completa.
- Suíte completa executada nesta retomada: **303 aprovados / 0 falharam / 0 ignorados**, zero cancelados, saída 0, duração de 81,803 segundos.
- Comando efetivo: `node --test test/*.test.js`, em `backend`, via runner local que verifica o diretório real do cluster antes da execução.
- Nenhuma alteração de produto ou teste foi necessária nesta retomada.
- O arquivo local antigo `focused.log` contém uma tentativa anterior com falha e não representa o resultado específico final informado pelo usuário. A suíte completa desta retomada passou integralmente.

Polling com tempo controlado e relógio real, fluxo cliente ↔ estabelecimento, independência diante de Evolution 429/offline e ausência de chamadas adicionais à Evolution durante o chat estão cobertos. Desktop (1440px), 390px e 360px validados; rascunho e foco preservados, enviar visível e ausência de rolagem horizontal nos cenários testados.

## PostgreSQL e resíduos

Na retomada não havia Node da suíte pendente; o cluster local de validação estava parado. Foi iniciado explicitamente em loopback, porta 55432, com verificação do diretório `.tmp/trial-validation-pg/data`. A primeira tentativa sem opções explícitas de porta falhou ao abrir sockets; nenhum teste foi executado nessa tentativa.

O runner sobrescreveu as variáveis de conexão dos testes para o PostgreSQL local separado. Produção não foi utilizada nesta validação. Zero schemas `test_<uuid>` antes e depois da suíte. Cluster encerrado com `pg_ctl stop -m fast -w`; confirmação posterior: `no server running`. Nenhum processo Node ou PostgreSQL adicional da validação permaneceu. Os processos PostgreSQL preexistentes, com os mesmos PIDs observados antes, foram preservados.

Os arquivos do cluster e artefatos locais anteriores foram preservados em `.tmp`, ignorado pelo Git. Não há banco temporário, screenshot, log ou script temporário no conjunto de alterações. Existem logs antigos já versionados no repositório, sem alteração nesta etapa.

## Backups

As exclusões eram `.codex/backups/README.md.bak`, `.codex/backups/app.js.bak` e `.codex/backups/routes.js.bak`. São arquivos versionados desde o commit inicial `ede335a`; o relatório 2C.3 já registrava as exclusões como preexistentes. Não pertencem à 2C e foram restaurados de HEAD, sem sobrescrever arquivos existentes.

Os hashes Git dos três arquivos restaurados coincidem com o índice/HEAD; `git diff --quiet -- .codex/backups` retorna 0. Os outros dois backups versionados (`evolutionApi.js.bak` e `render.yaml.bak`) também permanecem iguais a HEAD. O status local ainda pode indicar `M` por metadados dos arquivos restaurados, mas não há diff de conteúdo nem exclusão. Nenhum backup de produção foi manipulado.

## Arquivos efetivamente pendentes

Alterados em relação a HEAD:

- `backend/public/agendar.html`, `backend/public/agendar.js`
- `backend/public/studiofy.html`, `backend/public/studiofy.js`
- `backend/routes.js`
- `backend/test/migration.test.js`, `backend/test/studiofy-browser.test.js`

Novos arquivos da 2C:

- `backend/chatRoutes.js`, `backend/services/chat.js`
- `backend/database/migrations/009_studiofy_chat.sql`
- `backend/public/chat-inbox.css`, `backend/public/chat-inbox.js`
- `backend/public/chat-public.css`, `backend/public/chat-public.js`
- `backend/public/chat-sync.js`
- `backend/test/chat.test.js`, `backend/test/chat-inbox.test.js`, `backend/test/chat-public.test.js`, `backend/test/chat-sync.test.js`, `backend/test/chat-polling.test.js`
- `STUDIOFY-ETAPA2C.md`, `STUDIOFY-ETAPA2C3.md`, `STUDIOFY-ETAPA2C4.md`

`painel/index.html` é um arquivo não versionado preexistente, fora da 2C, preservado sem alterações. Nesta retomada apenas os três backups foram restaurados e este relatório foi criado.

## Diff, migration e limites

`git diff --check` passou. Revisão dos arquivos pendentes não encontrou credenciais reais, URL real de testes ou artefatos temporários. Nada foi adicionado ao stage. `.tmp/` continua ignorado.

Migration 009 é a única migration nova da 2C e continua aditiva: cria duas tabelas de chat e seus índices, sem alterar dados ou tabelas anteriores. O teste de migração verifica preservação dos dados anteriores. Hash SHA-256 antes/depois idêntico: `6663D8C9EAB115F062BFDDF1524B6B6ED6FA1F56DEF64C636125302712ECF250`. Índices revisados e suficientes para o escopo validado. Não aplicada em produção.

A única alteração em `backend/routes.js` registra `/chat`; não houve alteração da implementação Evolution. A correção de teste já existente em `studiofy-browser.test.js` seleciona especificamente `.cancel-dialog`, evitando confundir o diálogo de cancelamento com o novo diálogo do chat; mantém as verificações de confirmação e persistência do cancelamento.

Limites: polling periódico, sem WebSocket; mobile validado em navegador automatizado e viewport reduzido, sem dispositivo físico; sem ensaio de carga de produção; identidade declarada pelo visitante não comprova vínculo com cliente/agendamento; rascunhos voláteis. As conclusões de isolamento e layout se restringem aos cenários testados. Produção permanece sem a publicação da 2C.
