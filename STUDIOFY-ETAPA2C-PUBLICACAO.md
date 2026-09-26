# Studiofy — auditoria pré-publicação da Etapa 2C

Auditoria em 26/09/2026, após autorização explícita para publicar 2C.1–2C.4. Os relatórios anteriores registram entregas locais históricas; suas restrições de publicação foram substituídas pela autorização atual.

## Escopo revisado

API e serviço do Chat Studiofy, migration 009, widget público, inbox Conversas, sincronização por polling, integrações nas páginas existentes, testes e documentação. Nenhuma nova funcionalidade ou alteração visual acrescentada nesta auditoria. Resultado local preservado: **303 aprovados, zero falhas e zero ignorados**; específicos da 2C.4: **19 aprovados**.

## Segurança

- Estabelecimento derivado da sessão autenticada, nunca de um identificador arbitrário enviado pelo navegador. Consulta, busca, envio, histórico, leitura e contadores filtram a conta.
- Cliente identificado por segredo aleatório de 32 bytes, com hash SHA-256 persistido, expiração de 30 dias e escopo por estabelecimento. Telefone declarado não recupera nem autoriza acesso a outras conversas.
- Cookie de produção `__Secure-studiofy_chat`, `HttpOnly`, `Secure`, `SameSite=Strict`, sem `Domain`, com caminho restrito ao chat público do estabelecimento. Token não é retornado no JSON, URL ou armazenamento JavaScript.
- Escritas públicas exigem origem esperada, JSON e cabeçalho próprio; requisições cross-site são recusadas. Endpoints autenticados exigem token de sessão em cabeçalho.
- Entrada limitada e validada; SQL parametrizado; conteúdo renderizado por `textContent` ou escape HTML. Erros não revelam SQL, stack ou conteúdo privado.
- Limites por IP/conta e quota persistente de 30 mensagens por minuto por remetente/conversa, serializada por lock. Leituras são limitadas e paginadas. Busca por nome/telefone usa POST, filtro de conta e comparação literal.
- Autorização utiliza a política da Etapa 2B para trial/assinatura. Expiração bloqueia operações e preserva histórico.
- O chat não registra conteúdo privado em logs nem chama Evolution. Testes cobrem isolamento A/B, clientes diferentes, CSRF, XSS, tokens inválidos/expirados, idempotência e indisponibilidade externa.

Limites conhecidos: identificação do visitante autodeclarada; limitação HTTP em memória por processo (quota de mensagens persistida); busca parcial sem índice textual dedicado; polling de 8 segundos nas conversas e 20 segundos no badge, sujeito a visibilidade e backoff.

## Migration e backup

009 cria exclusivamente duas tabelas e índices do chat. Sem DROP, DELETE, TRUNCATE ou atualização de dados anteriores. Índices cobrem inbox, histórico incremental, não lidas, quota e unicidade/idempotência. Compatível com o migrador transacional existente, que verifica SHA-256 e usa advisory lock antes do startup.

Hash validado da 009: `6663d8c9eab115f062bfddf1524b6b6ed6fa1f56def64c636125302712ecf250`.

Backup pré-deploy do schema de produção feito pelo procedimento existente com `pg_dump --format=custom`, fora do Git. Arquivo de 64.122 bytes, leitura integral validada por `pg_restore --file=NUL`, sem restauração ou escrita no banco. SHA-256: `bef8c50c6fda64cafd79a00f9874860f98188c0c052ecf9c83a7d6026d5b92e8`.

Baseline de dados registrado em transação somente leitura, usando hashes por chave/coluna, sem conteúdo pessoal no relatório. Histórico pré-deploy: 001–008, com checksums iguais aos blobs publicados do Git. A migration 005 tem diferença local de fim de linha; o blob publicado corresponde ao banco e não foi alterado.

## Exclusões do commit e validação posterior

Backups `README.md.bak`, `app.js.bak` e `routes.js.bak` preservados com os mesmos blobs de HEAD. `painel/index.html` é preexistente e fora do escopo. Não incluir `.tmp`, dumps, screenshots, logs, scripts temporários, credenciais, variáveis de conexão de testes ou backups no commit.

A publicação deve usar um único commit em `origin/main`, startup normal do Render e nenhuma aplicação SQL paralela. Após o deploy: confirmar `/health` e SHA, histórico/checksums 001–009, preservação dos registros anteriores e homologação exclusivamente com dados de teste. Não desconectar WhatsApp, solicitar QR ou forçar conexão. Em falha de migration/startup/deploy, interromper sem correção destrutiva.

Este documento registra a auditoria anterior ao commit; o resultado efetivo do deploy e da homologação deve ser informado no relatório final, sem presumir sucesso antecipadamente.
