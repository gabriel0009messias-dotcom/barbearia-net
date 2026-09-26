# Etapa 2C — Chat Studiofy

**Atualização:** a 2C.3 também está implementada e validada localmente. Veja [o relatório da caixa de entrada](STUDIOFY-ETAPA2C3.md). O restante deste documento registra as entregas anteriores 2C.1/2C.2. A 2C.4 não foi iniciada.

Estado atual: **2C.1 — banco e API segura + 2C.2 — chat público**, somente local, sem commit, push ou deploy. A migration 009 foi executada apenas em schemas exclusivos de testes. O menu Conversas (2C.3) e o polling (2C.4) não foram iniciados. As seções abaixo preservam o relatório histórico da 2C.1; a validação da 2C.2 está no final deste documento.

## Plano apresentado antes da implementação

| Subetapa | Entrega |
| --- | --- |
| 2C.1 | Modelagem, sessão pública, API de mensagens/caixa de entrada, autorização e testes PostgreSQL. |
| 2C.2 | Botão flutuante em `/agendar/{slug}`, janela de conversa, identificação, texto e horários. |
| 2C.3 | Menu Conversas, badge, caixa de entrada, respostas e contexto de cliente/agendamentos quando houver vínculo seguro. |
| 2C.4 | Polling controlado, pausa em página oculta, backoff, tratamento de falhas, acessibilidade e acabamento. |

O backend publicado é Express com PostgreSQL, em `backend/app.js` e `backend/routes.js`. A sessão do estabelecimento já usa `x-barbeiro-token`. Não há infraestrutura de WebSocket nesse fluxo; a primeira versão usará a API HTTP e paginação por cursor, sem dependências novas. O frontend permanece em `backend/public`.

O Chat Studiofy é um canal independente. Não consulta conexão, QR Code, instância ou disponibilidade da Evolution. Não grava na fila de WhatsApp e não transforma mensagens entre canais. Nenhum arquivo da integração Evolution foi alterado.

## Modelagem e preservação

`009_studiofy_chat.sql` cria apenas:

- `chat_conversations`: UUID, `assinatura_id`, canal `studiofy`, nome/telefone informados, hash do token, validade da sessão, status e timestamps.
- `chat_messages`: conversa, remetente `customer`/`establishment`, conteúdo, UUID de idempotência, horário do servidor e horário de leitura.

Índices atendem caixa de entrada por estabelecimento, histórico, não lidas e quota de envio. As datas usadas nos cursores têm precisão de milissegundos, preservada pelo driver JavaScript. A última mensagem é consultada no histórico, sem duplicar seu conteúdo na conversa.

Não há backfill, alteração de contas, reescrita das migrations 001–008 ou exclusão de dados nessa migration. O migrador transacional existente continua sendo o único mecanismo de aplicação.

Expiração de trial ou sessão pública **não remove** conversas. As FKs com cascade atendem somente à exclusão explícita da conta pelo procedimento administrativo já existente: apagam os registros daquele estabelecimento sem deixar mensagens órfãs.

Não foi criada `conversation_participants`: nesta versão há exatamente um visitante e o estabelecimento, com os remetentes controlados no servidor.

A tabela legada `clientes` não é isolada por estabelecimento; o painel atual extrai clientes dos agendamentos. Um telefone informado sem verificação não prova titularidade. Por isso, não se associa automaticamente a conversa a cliente/agendamento, e `customerContext` retorna `null`. Um vínculo futuro deverá ser comprovado e limitado ao estabelecimento; nada é inventado ou exposto ao visitante.

## Sessão pública e autorização

O visitante inicia a sessão informando nome e telefone, sem senha. O servidor gera 32 bytes aleatórios; persiste apenas SHA-256 e envia o segredo exclusivamente em cookie:

- `HttpOnly`, `SameSite=Strict`, host-only, com path restrito a `/api/chat/public/{slug}`.
- `Secure` e prefixo `__Secure-` quando `NODE_ENV=production` ou `RENDER=true`, inclusive com terminação TLS no proxy.
- Validade fixa de 30 dias, conferida no PostgreSQL; não depende da memória do processo.
- Token ausente, inválido, expirado ou cookie duplicado não permite consultar mensagens.
- Não há token em URL, JSON ou localStorage. Não existe recuperação de conversa apenas por telefone. Perder/expirar o cookie exige uma nova sessão; o histórico anterior permanece para o estabelecimento.

O cookie válido retoma a mesma conversa; nome/telefone de um novo POST não substituem os dados da conversa existente. Cookies de outro estabelecimento não autorizam acesso, mesmo quando copiados manualmente no request.

O visitante nunca escolhe um conversation ID para ler/enviar. O painel usa UUID, mas o UUID não é a autorização: toda busca também exige `assinatura_id` da sessão validada no backend. IDs de estabelecimento enviados em body/query são recusados.

Todas as operações verificam a política central da 2B, inclusive dentro da transação. Trial ativo e assinatura ativa permitem acesso. Trial expirado sem acesso pago bloqueia leitura operacional, envio, criação e confirmação de leitura, conservando o histórico. Login, conta, planos e pagamento permanecem sob as rotas existentes.

## Contrato HTTP

Base pública: `/api/chat/public/{slug}`. O navegador envia cookies da mesma origem automaticamente. Para todos os POSTs públicos, usar JSON e `X-Studiofy-Chat: 1`; o navegador inclui `Origin`. O servidor exige origem exata de `PUBLIC_APP_URL` ou `RENDER_EXTERNAL_URL`; em desenvolvimento HTTP, permite a origem local da requisição. Produção sem origem configurada falha fechada. Origem externa e `Sec-Fetch-Site: cross-site` são recusados.

| Método/rota pública | Entrada | Resultado |
| --- | --- | --- |
| `POST /session` | `{name, phone}` | 201 e cookie novo, ou 200 para sessão já existente; resumo da conversa. |
| `GET /messages` | `before` ou `after`, opcionais | Histórico em ordem crescente, resumo e paginação. |
| `POST /messages` | `{content, clientMessageId}` | Mensagem persistida, 201; retry idêntico retorna a mesma mensagem com 200. |
| `POST /read` | `{throughMessageId}` | Marca apenas mensagens do estabelecimento até a mensagem informada; retorna resumo. |

Base do painel: `/api/chat/conversations`, com `x-barbeiro-token` em todas as chamadas.

| Método/rota do painel | Resultado |
| --- | --- |
| `GET /` | Até 50 conversas, ordenadas por atividade: UUID, canal, nome, telefone, status, última mensagem, horários, não lidas e `nextCursor`. |
| `GET /unread` | Totais `messages` e `conversations` com mensagens do cliente ainda não lidas. |
| `GET /{uuid}/messages` | Histórico e resumo privado, incluindo nome/telefone e `customerContext`. |
| `POST /{uuid}/messages` | Resposta do estabelecimento; mesmo contrato de idempotência do visitante. |
| `POST /{uuid}/read` | Confirma leitura das mensagens do cliente até `throughMessageId`. |

Uma mensagem retorna `id`, `sender_type`, `content`, `client_message_id`, `created_at` e `read_at`. O horário e o remetente são definidos no backend. Não são aceitos campos extras para alterar canal, estabelecimento, remetente, datas ou conversa.

Histórico retorna `messages`, `hasMore`, `oldestId` e `newestId`, até 50 mensagens. Sem cursor, retorna as últimas 50. `before=oldestId` busca mais antigas; `after=newestId` busca novas. Se `hasMore=true`, continuar a página na direção escolhida. A caixa de entrada usa seu próprio `cursor=nextCursor`, opaco e sem credenciais.

Consultar histórico não marca como lido. A futura UI deve confirmar somente a última mensagem efetivamente exibida, com a conversa visível. Mensagens posteriores ao marcador permanecem não lidas; marcadores de outra conversa são recusados. As leituras são idempotentes e não alteram o horário de uma leitura já registrada.

## Validação, privacidade e limites

- Nome: texto não vazio, até 80 caracteres. Telefone: 10–15 dígitos, com formatação simples normalizada; não verifica titularidade.
- Mensagem: texto não vazio, até 2.000 unidades UTF-16; aceita quebras de linha e Unicode. Objetos, markup com `<`/`>` e caracteres de controle são rejeitados. A futura UI deve usar `textContent` ou escape já adotado no projeto, jamais interpretar o conteúdo como HTML.
- SQL parametrizado; respostas de falha interna são genéricas. O chat não registra nomes, telefones, mensagens ou tokens em logs.
- Respostas `no-store`, `nosniff` e `no-referrer`. O telefone só aparece no painel autenticado; endpoints do visitante não o retornam.
- Criação pública: até 5 solicitações por IP a cada 15 minutos.
- Envio público: até 30 solicitações por IP/minuto. Leituras/confirmações públicas: até 120 por IP/minuto.
- Painel: até 120 leituras e 60 escritas por estabelecimento/minuto.
- Quota adicional persistida: 30 mensagens por conversa/remetente/minuto, com lock da conversa no PostgreSQL. Idempotência é resolvida antes da quota persistida, sem duplicar mensagens ou não lidas.
- Limites HTTP por IP/estabelecimento usam o store em memória do `express-rate-limit` existente e reiniciam junto ao processo. A quota por conversa continua após restart e vale entre processos. Escala horizontal exigirá store compartilhado para os limites HTTP; não foi introduzido Redis nesta versão.
- No proxy atual, o limite público considera o endereço mais próximo informado pelo proxy, evitando confiar no primeiro valor arbitrário de `X-Forwarded-For`. Mudanças na cadeia de proxies exigem revisar a resolução de IP.

Os limites retornam HTTP 429 com `Retry-After`. Para 2C.4, prever polling de aproximadamente 15 segundos somente quando visível, no máximo uma requisição por vez, cursor incremental e backoff em falhas/429. Nenhum timer ou polling foi introduzido nesta entrega.

## Validação local

Os testes usam o PostgreSQL isolado da validação da 2B, em loopback na porta 55432, banco de testes e papel restrito. O diretório real do cluster é conferido antes da execução. Cada suíte cria e limpa apenas seu schema `test_<uuid>`. Nenhum teste usa a conexão de produção do `.env`.

Cobertura adicionada: criação, envio/resposta, histórico completo paginado, não lidas, confirmação de leitura, idempotência concorrente, isolamento de clientes/estabelecimentos, IDs adulterados, tokens inválidos/expirados, CSRF, XSS, limites de texto e tráfego, trial ativo/expirado, assinatura ativa, Evolution 429 e ausência de WhatsApp. Inclui cookie real em Chrome, flags de produção, paginação da caixa de entrada e exclusão isolada por FK.

O teste de upgrade compara todas as tabelas existentes antes/depois da 009; o teste do migrador existente verifica aplicação concorrente/repetida e histórico 001–009. A regressão também cobre importação SQLite, Mercado Pago, WhatsApp e interfaces anteriores.

Resultado final: **253 testes aprovados, zero falhas, zero ignorados**, exit code 0, em 46,94 segundos. Comando equivalente a `npm test`: `node --test test/*.test.js`, executado em `backend` com conexão local de testes configurada somente nos processos. Inclui todos os 231 testes da base anterior e os 22 testes adicionados (grupo e subtestes).

Logs mantidos fora do Git em `.tmp/chat-validation/`. A primeira execução focada identificou uma fixture com slug nulo, corrigida para o fallback real `studio-{id}`; não foi necessário alterar o cadastro. As execuções completas posteriores passaram. A rodada final inclui o ajuste de precisão e validação dos cursores da caixa de entrada.

Verificações finais: sintaxe JavaScript e `git diff --check` passaram; auditoria dos sete arquivos da entrega sem credenciais reais; migrations 001–008, frontend e arquivos da Evolution sem alterações. A consulta ao cluster local confirmou **zero schemas temporários de teste restantes**. O cluster iniciado para esta validação foi parado sem apagar seus arquivos. O banco/serviço de produção não foi usado.

Entrega encerrada na **2C.1**. Sem commit, push, deploy, migration em produção ou implementação de 2C.2–2C.4. As exclusões preexistentes em `.codex/backups` e o arquivo preexistente `painel/index.html` não pertencem à entrega e foram mantidos como estavam.

## 2C.2 — conclusão da implementação e validação

A retomada revisou o diff e preservou a implementação existente: botão azul, identificação sem conta/senha, histórico, envio, cookie, Escape, retorno de foco, adaptação ao viewport e atualização manual. A execução interrompida tinha uma falha de sincronização do teste de viewport reduzido. A busca de respostas depois do envio ainda não estava implementada: somente a mensagem enviada era acrescentada à tela.

Foram concluídos a atualização após envio e seu tratamento de falha (a confirmação do envio permanece, sem duplicar mensagem), a navegação circular por Tab/Shift+Tab, o contraste dos labels/campos/foco e o espaço da identificação no desktop. O texto de presença agora orienta a usar **Atualizar conversa**, sem sugerir atendimento em tempo real. Não há polling; o único timer do widget limita o tempo de uma requisição em andamento.

### Resultado funcional

| Verificação | Resultado |
| --- | --- |
| Cliente | Chrome real abriu `/agendar/{slug}`, identificou nome/telefone, criou conversa na API 2C.1, enviou mensagem, recebeu confirmação e retomou a mesma conversa ao fechar/abrir e ao recarregar a página. |
| Sessão e privacidade | Cookie HttpOnly e SameSite=Strict; flags Secure e prefixo `__Secure-` de produção cobertos pela suíte da API. HTTP em loopback usa a exceção local de desenvolvimento. Segredo do chat ausente da URL, HTML, localStorage/sessionStorage e erros exibidos. O armazenamento preexistente dos links privados de agendamento é independente. |
| Histórico | Paginação real com mais de 100 mensagens, sem perda/duplicação; cliente à direita e estabelecimento à esquerda; horários comparados com a formatação pt-BR do timestamp no fuso do navegador. |
| Texto | HTML do histórico aparece como texto e não executa. Entrada com markup é recusada. Mensagem com 2.000 caracteres aceita; 2.001 recusada pela interface e pela API. |
| Atualizar conversa | Resposta enviada pelo endpoint autenticado do estabelecimento não aparece espontaneamente; aparece após clique em Atualizar conversa. Abrir e enviar também buscam o histórico. |
| Evolution | Nenhuma ação do Chat Studiofy chama a Evolution API. O teste provoca 429 numa consulta explícita de WhatsApp, fora do chat, e confirma envio/atualização do chat sem novas chamadas externas. Não foi feita correção de 429. |
| Acesso | Trial ativo e assinatura ativa permitem operações. Trial expirado sem assinatura bloqueia operações e preserva o histórico. A interface apresenta exatamente: “O chat deste estabelecimento está temporariamente indisponível.” Sem revelar situação financeira. |
| Agendamento | Serviço → profissional → data → horário → confirmação e cancelamento passaram com chat fechado, identificação aberta entre etapas e conversa existente. Seleções/HTML e requisições de disponibilidade/reserva foram comparados: abrir/fechar chat não os altera. |

O chat usa um **dialog modal**: enquanto aberto, o formulário de agendamento fica inacessível; o cliente fecha por botão ou Escape para continuar de onde parou. A regressão abre/fecha a janela nas etapas de seleção e confirmação, verifica a preservação de todos os campos e compara as mesmas requisições nos três cenários.

### Visual e acessibilidade

Screenshots revisados em **1440×1000, 390×800 e 360×800**: fechado, identificação, mensagens curtas/longas e erros. Viewport reduzido a **420px de altura** valida campo de envio, fechar e atualização com espaço reduzido. Não houve rolagem horizontal nos cenários verificados. O teste aguarda o evento de `visualViewport` antes de medir a posição dos controles.

Labels associados aos campos, título do dialog, nomes acessíveis dos botões, status anunciado, foco inicial, Tab/Shift+Tab, Escape e retorno ao botão flutuante foram conferidos. Controles de fechar, atualizar e enviar têm pelo menos 44×44px; os pares de cores de texto verificados passam contraste mínimo de 4,5:1. Bordas e foco receberam cores próprias para não herdar o tema escuro da página.

Limite da validação: navegador Chrome automatizado com larguras mobile e simulação de viewport reduzido; não foi usado teclado virtual em aparelho físico nem leitor de tela real. Os screenshots permanecem exclusivamente em `.tmp/chat-public-preview/`, ignorado pelo Git.

### Testes finais

PostgreSQL exclusivo de testes em **127.0.0.1:55432**, diretório `.tmp/trial-validation-pg/data` conferido antes de cada execução, banco `studiofy_test`, papel restrito `studiofy_runner` e schemas exclusivos `test_<uuid>`. Nenhuma conexão de produção foi usada.

| Execução | Aprovados | Falharam | Ignorados |
| --- | ---: | ---: | ---: |
| `node --test test/chat-public.test.js` | **15** | **0** | **0** |
| `node --test test/*.test.js` (equivalente a `npm test`) | **268** | **0** | **0** |

Contagens exatas do Node, incluindo o teste principal e seus subtestes. Duração final: 13,51s focado e 65,40s suíte completa; ambos exit code 0, sem cancelados. Logs: `.tmp/chat-public-validation/focused.log` e `full.log`.

Após a suíte final, a consulta confirmou **zero schemas temporários restantes**. O cluster local iniciado para esta validação foi encerrado, preservando seus arquivos.

Falhas intermediárias corrigidas: fixture de histórico recente acionava a quota legítima de envio (alterada para histórico de um dia); teste de teclado precisava usar keydown/keyup para Shift; fixture de agendamento recebeu viewport explícito; navegação por Tab saía do dialog; seletor genérico de `dialog` no teste antigo de cancelamento foi especificado como `.cancel-dialog`. A suíte completa foi repetida após a última correção e passou integralmente. Sintaxe JavaScript e `git diff --check` também passaram.

Arquivos da 2C.2: `backend/public/chat-public.css`, `backend/public/chat-public.js`, integração em `agendar.html`/`agendar.js`, `backend/test/chat-public.test.js`, ajuste de seletor em `backend/test/studiofy-browser.test.js` e este relatório. Os arquivos pendentes da 2C.1 e as alterações preexistentes fora do escopo foram preservados.

**Entrega encerrada na 2C.2 para revisão.** Sem commit, push, deploy ou migration 009 em produção. Sem início de 2C.3 ou 2C.4.
