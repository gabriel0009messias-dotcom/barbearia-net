# Auditoria Inicial

## Achados principais

- O `backend/package.json` apontava para `src/server.js`, mas esse arquivo nao existia.
- O projeto mistura duas arquiteturas:
  - legado: `backend/app.js`, `backend/database.js`, `backend/asaas.js`, SQLite, Asaas e paginas HTML/JS;
  - nova base parcial: `backend/src/*`, PostgreSQL e Mercado Pago, mas sem servidor HTTP conectado.
- Existem credenciais hardcoded no legado, incluindo admin e token de pagamento. Essas credenciais devem ser consideradas comprometidas e precisam ser regeneradas.
- O frontend `painel` nao esta concluido como React + Vite; hoje existe mistura de HTML estatico e React parcial sem pipeline real de build.
- O deploy em `render.yaml` ainda referencia a stack legada e variaveis ligadas ao fluxo antigo.

## Decisao de migracao

- A arquitetura oficial passa a ser consolidada em `backend/src`.
- Arquivos legados nao foram removidos nesta fase para evitar perda funcional antes da migracao completa.
- Foi criada a base oficial de servidor, autenticacao multi-tenant, CRUDs centrais e migrations SaaS em PostgreSQL.

## Proximos passos

- Migrar frontend para React + Vite aproveitando o que for util das telas atuais.
- Integrar Mercado Pago ao fluxo novo de `subscriptions` e `payments`.
- Integrar Evolution API ao fluxo novo de `whatsapp_sessions`.
- Atualizar `render.yaml` para a arquitetura oficial.
