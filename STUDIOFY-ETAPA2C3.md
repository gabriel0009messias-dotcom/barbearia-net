# Studiofy — Etapa 2C.3: Conversas no painel

Entrega local concluída para revisão. A base 2C.1/2C.2 foi preservada. **Sem commit, push, deploy, migration 009 em produção ou implementação de 2C.4.**

## 1. Arquivos desta etapa

| Arquivo | Alteração |
| --- | --- |
| `backend/public/chat-inbox.js` | Novo módulo da caixa de entrada, busca, histórico, resposta, leitura, estados e ciclo de vida. |
| `backend/public/chat-inbox.css` | Layout desktop/mobile, canal azul, mensagens, dados de contato e adaptação ao viewport. |
| `backend/public/studiofy.html` | Carregamento dos arquivos da inbox. |
| `backend/public/studiofy.js` | Menu Conversas, badge, integração com acesso/assinatura e exclusão de Conversas do timer preexistente do painel. |
| `backend/chatRoutes.js` | Nova rota autenticada de busca, usando a autorização e o limite de leituras existentes. |
| `backend/services/chat.js` | Filtro de busca parametrizado, sempre limitado ao estabelecimento autenticado. |
| `backend/test/chat-inbox.test.js` | Validação com navegador, API real e PostgreSQL isolado. |
| `STUDIOFY-ETAPA2C.md` / `STUDIOFY-ETAPA2C3.md` | Referência e relatório desta entrega. |

Os demais arquivos pendentes da 2C.1/2C.2, as exclusões preexistentes de `.codex/backups` e `painel/index.html` foram mantidos como estavam. A migration 009 não foi alterada nesta etapa.

## 2. Caixa de entrada

Menu **💬 Conversas**, depois de Agendamentos, com badge de mensagens não lidas. Desktop: lista à esquerda e conversa selecionada à direita. Lista em ordem de atividade recente, com nome, última mensagem, horário, identificação azul **Chat Studiofy** e badge individual. Paginação de 50 conversas, com botão Mais conversas.

Histórico com cliente à esquerda e estabelecimento à direita, horários pt-BR no fuso do navegador e data completa no título do horário. Botão Ver mensagens anteriores usa o cursor da API 2C.1. Textos retornados são escapados antes de compor o HTML; markup não executa.

Estados implementados: inbox vazia, nenhum resultado de busca, conversa sem mensagens, carregamento da lista/histórico, envio em andamento, confirmação, falha de envio/carregamento e limite de tentativas. Erros externos não são reproduzidos na tela. Falha ao abrir no mobile retorna à lista e permite nova tentativa.

## 3. Não lidas

O badge geral representa **quantidade de mensagens**, e não quantidade de conversas. Os valores vêm de `/api/chat/conversations/unread`; cada item usa `unread_count` retornado pelo backend.

Após desenhar o histórico e rolá-lo até a mensagem mais recente, com a conversa aberta e o documento visível, a inbox envia `throughMessageId` ao endpoint `/read`. O backend marca somente mensagens do cliente até aquele marcador. Mensagens posteriores não são incluídas. Em seguida, lista e total geral são consultados novamente.

Consultar apenas a lista não marca como lido. Abrir mensagens antigas não avança o marcador de leitura. O frontend não persiste nem calcula por conta própria o estado de leitura.

**Sem tempo real:** mensagens recebidas no servidor aumentam os totais no backend; a interface os conhece ao atualizar. O total também é consultado uma vez ao iniciar o painel e ao entrar em Conversas. Não existe polling novo. O timer preexistente do restante do painel ignora a seção Conversas e não atualiza seu badge em segundo plano.

## 4. Resposta

Usa `POST /api/chat/conversations/{uuid}/messages`, com a sessão autenticada do estabelecimento, conteúdo de até 2.000 caracteres e UUID de idempotência. HTML é recusado. Campos e ações ficam bloqueados durante a operação; falhas preservam o rascunho e o identificador para nova tentativa.

Após confirmar o envio, busca novamente histórico, lista e total. Se o envio funcionar mas a atualização falhar, mantém a confirmação e orienta usar Atualizar conversa, sem tratar a mensagem como não enviada. Há atualização manual da lista e da conversa. Requisições são abortadas ao sair da seção; rascunhos ficam somente na memória daquela abertura da inbox.

Nenhuma ação da inbox chama WhatsApp/Evolution. O teste provoca 429 em uma consulta explícita de WhatsApp, fora da inbox, e confirma que leitura e resposta do Chat Studiofy continuam funcionando sem chamadas externas adicionais. Nenhuma correção de 429 nem integração de inbox WhatsApp foi feita.

## 5. Busca e alteração na API 2C.1

Nova rota: **`POST /api/chat/conversations/search`**.

Entrada JSON: `{ "query": "nome ou telefone", "cursor": "opcional" }`. Resposta mantém `{ conversations, nextCursor }`. Busca por parte do nome, sem distinguir maiúsculas/minúsculas, ou por parte do telefone normalizado. Formatação de telefone (`+`, espaços, parênteses, pontos e hífens) é removida seguindo a mesma regra de dígitos da identificação. A busca é enviada ao pressionar Buscar/Enter, sem requisição a cada tecla.

Termo limitado a 80 caracteres; campos extras, tipos inválidos e controles são recusados. SQL parametrizado com busca literal: `%` não funciona como curinga. O filtro sempre inclui `assinatura_id` obtido da sessão validada no servidor. Cursores continuam sendo opacos e não autorizam acesso entre contas.

Usa o limite existente de **120 leituras por estabelecimento/minuto**, compartilhado com a listagem. A busca usa POST para evitar nome/telefone em URLs. Não há alteração de schema, migration adicional ou mudança nos contratos anteriores de histórico/envio/leitura.

Limitações: busca não remove acentos e não é busca aproximada. É uma consulta parcial no PostgreSQL, sem índice de busca textual dedicado; volume elevado deverá ser medido antes de ampliar a arquitetura.

## 6. Cliente e agendamento

Área discreta expansível **Cliente · Dados de contato**, com nome e telefone retornados pela API autenticada.

O contrato 2C.1 retorna `customerContext: null`: não existe vínculo de identidade comprovado. Um telefone digitado livremente e nomes parecidos não autorizam associar agendamentos. Portanto, não são inventados próximo agendamento, último atendimento, Ver cliente ou Ver agendamento. A interface informa que os dados foram declarados pelo cliente e que não há vínculo verificado.

## 7. Mobile e revisão visual

Preview revisado em **1440×1000, 390×800 e 360×800**. No celular, a lista vem primeiro; tocar em um item abre a conversa ocupando a área visível, com **← Voltar para conversas**. Voltar preserva a lista e a busca. A caixa de resposta acompanha `visualViewport` e o safe area; com altura reduzida, dados de contato são ocultados para preservar os controles essenciais.

Conferidos inbox vazia, várias conversas, não lidas, conversa aberta, mensagens curtas/longas, dados do cliente, campo de resposta, retorno à lista e falha de carregamento. Sem rolagem horizontal nos cenários testados. Botões principais têm altura mínima de 44px, campos têm labels, foco visível e estados usam `role=status`.

Screenshots exclusivamente em `.tmp/chat-inbox-preview/`, ignorado pelo Git. Limite da validação: Chrome automatizado com larguras mobile e altura de 420px para simular a redução pelo teclado; sem aparelho físico ou leitor de tela real.

## 8. Segurança, privacidade e acesso

Testes verificam que A não lista, busca, abre, responde ou marca mensagens de B, nem obtém seus dados de contato. Parâmetros de estabelecimento fornecidos pelo navegador são recusados. A nova busca recebe exatamente a mesma autorização central da 2C.1.

Trial ativo e assinatura ativa permitem operações. Trial expirado sem assinatura bloqueia operações e preserva integralmente as mensagens. A interface retorna à área de assinatura; planos/pagamento e consulta de conta continuam acessíveis.

Telefone, busca e conteúdo não aparecem nas URLs. Histórico e rascunhos não são gravados em localStorage/sessionStorage; o token de autenticação do painel mantém o mecanismo preexistente. O módulo não grava conteúdo de conversa em logs e não mostra stack trace, SQL ou IDs internos em erros.

## 9. Testes finais

PostgreSQL exclusivo de testes: **127.0.0.1:55432**, banco `studiofy_test`, papel restrito `studiofy_runner`, schemas exclusivos `test_<uuid>`. O runner verifica o diretório real do cluster `.tmp/trial-validation-pg/data` antes de executar testes. Nenhuma conexão de produção foi usada.

| Execução | Aprovados | Falharam | Ignorados |
| --- | ---: | ---: | ---: |
| `node --test test/chat-inbox.test.js` | **16** | **0** | **0** |
| `node --test test/*.test.js` (equivalente a `npm test`) | **284** | **0** | **0** |

Contagens exatas do Node, incluindo grupo principal e subtestes. Exit code 0, sem cancelados. Durações: **11,43s** focado; **61,42s** suíte completa. Logs somente em `.tmp/chat-inbox-validation/`.

Cobertura: listagem/ordenação; conversa vazia; resposta; atualização manual; não lidas e confirmação no banco; busca por nome e telefone; busca/lista além de 50 resultados; histórico paginado; XSS; limites de texto; erros e retry idempotente; limite real da busca e isolamento do limite entre contas; autorização A/B; trial/assinatura; Evolution 429; mobile e viewport reduzido; navegação por todas as seções do painel. A suíte completa inclui a regressão anterior de operações do painel e do agendamento/chat público.

Sintaxe JavaScript e `git diff --check` passaram. Após a suíte, o cluster apresentou **zero schemas temporários de teste restantes** e foi encerrado, preservando seus arquivos.

## 10. Limites e encerramento

Atualização manual deliberada: nenhuma entrega ou badge é apresentado como tempo real. A 2C.4 permanece pendente. Sem vínculo seguro com clientes/agendamentos e sem inbox WhatsApp. Rascunhos são voláteis: sair da seção ou recarregar descarta o conteúdo não enviado. Testes mobile são em navegador automatizado, não em aparelho físico.

**Parar na 2C.3 para revisão. Nenhum commit, push, deploy ou migration em produção.**
