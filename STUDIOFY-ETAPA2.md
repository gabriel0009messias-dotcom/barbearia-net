# Studiofy — plano 2A, 2B e 2C

## Escopo autorizado

Análise do pedido de 24/09/2026 e implementação somente da etapa 2A. Sem commit, push ou deploy nesta etapa. Base publicada: `99e0198`. Referência visual recebida nesta sessão: descrição textual; nenhum arquivo de imagem acompanhou o anexo. A apresentação usa a identidade azul/marinho e a demonstração de smartphone do próprio Studiofy.

O backend ativo é `backend/app.js`, com rotas em `backend/routes.js`, `backend/studiofyRoutes.js`, frontend estático em `backend/public` e PostgreSQL. `painel/` e `backend/src/` não substituem esse fluxo. Migrations 001–007 existentes serão preservadas.

## 2A — Landing page e demonstrações

Transformar `/` na apresentação pública do produto e preservar o formulário de autenticação em `/login.html`, sem alterar o contrato de login. Menu: Início, Como funciona, Demonstração, Recursos, Para quem é, Preços, Entrar e Teste grátis.

Inclui: título solicitado; smartphone ilustrativo; demonstração interativa de serviço, profissional, data, horário e confirmação; conversa de WhatsApp fictícia; mockup de dashboard com faturamento, agendamentos, ticket médio, clientes novos, gráfico semanal, serviços e agenda; seis segmentos em apresentação equilibrada; recursos; preço obtido de `/api/publico/assinatura-config`; layout responsivo, menu móvel e respeito à preferência por movimento reduzido.

O mockup é identificado como composição ilustrativa, não captura de produção nem comprovação de indicadores existentes no painel. Nenhuma mensagem, reserva ou cobrança é gerada pelo tour. Valores de faturamento e clientes são fictícios. O preço da assinatura, por outro lado, vem da configuração real; erro de rede ou formato inválido produz orientação para consultar o cadastro, sem fallback monetário inventado.

O teste de 7 dias depende de 2B. Nesta etapa os CTAs “Teste grátis” e “Começar teste grátis” apontam para um bloco que informa que o teste ainda não pode ser iniciado e oferece a demonstração. A condição também aparece no primeiro bloco e nos preços. O link separado de cadastro informa que o fluxo atual exige assinatura. Não há ativação falsa de trial ou redirecionamento silencioso ao checkout.

### Arquivos de 2A

- `backend/public/index.html`: nova apresentação pública.
- `backend/public/studiofy-home.css` e `studiofy-home.js`: estilos e interações isoladas; uma consulta GET à configuração pública de preço.
- `backend/public/login.html`: formulário original, preservando `landing.js`, IDs e demonstração existente de WhatsApp.
- `backend/public/cadastro.html`, `cadastro.js`, `recuperar-senha.html`, `redefinir-senha.html`, `pagamento-pix.html`: navegação/textos de retorno ao Login.
- `backend/public/studiofy.js` e `barbeiro.js`: destinos de sessão expirada/logout apontam ao Login.
- `backend/test/auth-visual.test.js`, `cadastro-browser.test.js` e `studiofy-browser.test.js`: endereço do Login atualizado.
- `backend/test/landing-browser.test.js`: tour, isolamento de rede, preço, erros, navegação, responsividade, autenticação simulada e fallback sem JavaScript.
- Este documento: plano e evidências.

**Banco: nenhuma alteração.** Riscos: quebrar links que assumiam Login em `/`, confundir mockups com recursos operacionais ou apresentar trial inexistente. Mitigações: links de autenticação atualizados; testes de retorno ao Login; rótulos de demonstração e condição do trial explícita; nenhuma alteração de regras de assinatura nesta etapa.

## 2B — Trial de 7 dias (planejado, não implementado)

### Modelagem e fluxo

`assinaturas` já possui campos legados `trial`, `trial_usado`, `trial_started_at` e `trial_expires_at`, atualmente sem conceder o trial solicitado. Os timestamps legados são TEXT. Não basta mudar o formulário: a avaliação de acesso trata status `teste` como não liberado.

1. Criar uma migration aditiva nova, após conferir a próxima numeração. Compatibilizar os campos legados com timestamps confiáveis (`TIMESTAMPTZ`) e estado explícito do trial. Proposta: `trial_ends_at` e `trial_status`, preservando `trial_expires_at` e registros anteriores; decidir a conversão de `trial_started_at` somente após auditar valores históricos. Não reescrever migrations aplicadas.
2. Gerar início e fim no servidor/banco, na transação do cadastro, exatamente uma vez. Não aceitar datas, status ou duração do navegador. Usar restrições, unicidade dos identificadores de conta já adotados e controle transacional para impedir reinício por atualização/repetição concorrente. Não conceder trial retroativo indiscriminadamente.
3. Cadastro novo elegível recebe 7 dias sem iniciar checkout nem exigir pagamento. Conta existente nunca ganha um novo trial por reenviar o cadastro. Tratamento de identidade deve preservar empresas legítimas; impedir contas ilimitadas com identidades inteiramente novas requer verificação de contato e controles adicionais, não apenas uma flag.
4. Centralizar a regra de acesso respeitando bloqueio administrativo, assinatura paga e liberação manual. Expiração calculada a cada acesso no backend, sem depender de navegador ou worker para bloquear. Manter os dados após o término.
5. Painel mostra prazo restante a partir do estado fornecido pelo servidor e “Assinar Studiofy”. Após expiração, mostrar aviso e manter rotas necessárias para autenticação, consulta do plano e pagamento; restringir funções conforme política atual. Definir como tratar página pública, reservas futuras e lembretes de compromissos já criados antes de bloquear workers indiscriminadamente.
6. Reutilizar checkout, pagamentos e webhooks Mercado Pago atuais, com idempotência e reconciliação. Definir a transição para assinatura durante o trial sem alterar regras existentes de preço e período silenciosamente.

### Arquivos/tabelas e riscos

Afetará `backend/routes.js` (cadastro, sincronização de vencimento, acesso, login), serviços em `backend/services/payments/`, uma nova migration em `backend/database/migrations/`, `assinaturas`, cadastro e painéis (`studiofy.js`, `barbeiro.js`, respectivos HTML). As tabelas existentes `mercado_pago_orders` e `mercado_pago_payments` continuam sendo usadas pelo fluxo atual, sem sistema paralelo.

Testes obrigatórios em PostgreSQL exclusivo: cadastro elegível, requisições duplicadas/concorrentes, tentativa de injetar datas, alteração de perfil sem reinício, relógio e fronteira exata dos 7 dias, assinatura durante/depois do trial, webhook duplicado, acesso manual, conta bloqueada, preservação de dados e agendamentos/lembretes após expiração. Riscos principais: acesso indevido, bloqueio de contas pagas, duplicidade de cobrança e interpretação incorreta de timestamps legados. Revisar a política antes de publicar.

## 2C — Chat Studiofy independente (planejado, não implementado)

### Arquitetura e segurança

Cliente ↔ backend Studiofy/PostgreSQL ↔ estabelecimento. WhatsApp/Evolution continua sendo um canal separado. O chat não importa o adaptador Evolution nem condiciona carregamento/envio ao status dessa integração. Timeout, 429 ou desconexão da Evolution não devem bloquear operações internas.

Proposta aditiva: `conversations` com identificador público aleatório, `assinatura_id`, canal `studiofy`, nome e identificador de contato informados, datas de criação/atividade e estado; `messages` com conversa, empresa, remetente, texto limitado, `created_at` e `read_at` pelo destinatário; tabela de credenciais/participantes se houver múltiplos dispositivos autorizados. Tokens de acesso do cliente aleatórios, com apenas hash persistido, nunca deriváveis do telefone ou ID sequencial. UUID público sozinho não substitui autorização.

As consultas do estabelecimento devem sempre combinar a conversa com `req.assinatura.id`. Mensagens usam chaves estrangeiras compostas ou restrições equivalentes para não misturar empresa e conversa. Sessão do cliente deve comprovar a credencial vinculada àquela conversa/empresa em todas as operações de leitura e envio. Não listar ou reabrir conversas por nome/telefone informado; a posse de um telefone digitado não comprova identidade. Vincular histórico de atendimento ao contato somente com critério de verificação adequado, evitando expor dados de homônimos ou números falsamente informados.

Aplicar limites de tamanho e conteúdo, renderização com escape, paginação, anti-spam por IP/empresa/credencial e limites persistentes ou compartilhados para suportar mais de um processo. Criação e envio idempotentes, índices por empresa/conversa/horário e recibos de leitura distintos para cliente e estabelecimento. Credencial não deve aparecer em URLs de logs; avaliar cookie HttpOnly/SameSite e proteção de CSRF conforme o transporte escolhido. Para outro dispositivo, exigir um mecanismo seguro de recuperação, não apenas informar telefone.

Inicialmente pode usar consultas incrementais/polling com intervalo limitado, pausa em abas ocultas e cursor de mensagens; WebSocket/SSE só se justificado pelo deploy e autenticação. Falhas da consulta de WhatsApp exibem “WhatsApp temporariamente indisponível. O Chat Studiofy continua funcionando.”, sem reenviar nem mudar canal de mensagens silenciosamente.

### Interface, arquivos/tabelas e riscos

`backend/public/agendar.html` e `agendar.js`: botão flutuante e conversa, com nome e contato antes da primeira mensagem. `backend/public/studiofy.html`, `studiofy.js`, `studiofy.css`: seção Conversas, cliente, última mensagem, horário, não lidas, canal, histórico e resposta. Nome/telefone, próximo agendamento e último atendimento aparecem apenas quando a associação estiver autorizada. Identificar “Chat Studiofy” em azul e “WhatsApp” em verde; mensagens internas nunca são rotuladas como enviadas pelo WhatsApp.

Backend: novo serviço de chat e módulo de rotas, montados no fluxo ativo; nova migration aditiva e tabelas acima. `assinatura_id` permanece a chave de isolamento existente. Não copiar sessão do cliente público para a autenticação do estabelecimento.

Testes obrigatórios: empresa A versus B, cliente A versus B alterando ID/URL, credencial ausente/inválida/revogada, SQL/XSS, paginação e leituras concorrentes, duplicidade de envio, rate limiting, ausência de dados pessoais em logs, falhas 429/timeout/desconexão da Evolution com chat ainda funcional. Definir retenção e recuperação de acesso antes de disponibilizar o canal. Não implementar ou publicar sem nova autorização.

## Validação inicial de 2A

Comando final: `npm.cmd test` em `backend`. Resultado: **130 testes contabilizados; 115 aprovados; 14 falharam na preparação por ausência de `TEST_DATABASE_URL`; 1 ignorado pelo mesmo motivo; nenhum cancelado**. O comando retorna código 1 e a integração PostgreSQL não está homologada integralmente. Log: `.tmp/etapa2a-all-tests.log`. Não foi usado o banco de produção para esses testes.

O conjunto novo da landing passou (8 testes contabilizados). Verificou a sequência completa com voltar/reiniciar, ausência de POST/WhatsApp/reservas/storage no tour, preço vindo da API e fallback para indisponibilidade/formato inválido, aviso de trial não disponível, menu por teclado, retorno de sessão expirada ao Login, links internos válidos e funcionamento básico sem JavaScript. Layout verificado em 1440, 768, 390 e 320 pixels, sem rolagem horizontal. Testes existentes de Login/Cadastro e multissegmento com API simulada também passaram. No teste da animação, a reprodução agora é iniciada explicitamente após receber a configuração, para não depender de timing da navegação na suíte concorrente.

Inspeção visual realizada nas capturas desktop e celular, smartphone, demonstração de agendamento/conversa e dashboard. O Login conserva integralmente o HTML anterior, desconsiderando somente a representação CRLF/LF. `git diff --check` e verificação sintática dos JavaScripts alterados passaram. Nenhuma alteração em `app.js`, rotas de backend, serviços ou migrations.

Prévia local: **http://127.0.0.1:3022**. Servidor estático temporário em `.tmp/etapa2a-preview.cjs`, vinculado apenas a loopback, que lê o plano do módulo existente `services/payments/plan.js` e não conecta PostgreSQL/Evolution/Mercado Pago. Nesta prévia, operações de conta retornam indisponibilidade deliberadamente; os fluxos de autenticação/cadastro foram testados separadamente com APIs simuladas. Para rever a prévia caso o processo seja encerrado: `node .tmp/etapa2a-preview.cjs` na raiz.

Capturas finais: `.tmp/etapa2a-preview/landing-local-1440.png`, `landing-local-390.png` e `dashboard-final.png`. Screenshots e scripts temporários ficam em `.tmp/`, ignorada pelo Git. As exclusões preexistentes em `.codex/backups/` e `painel/index.html` não fazem parte da etapa. Nenhum commit, push ou deploy foi realizado. **2B e 2C permanecem apenas planejadas.**

## Revisão visual final de 2A

### Preparação da publicação aprovada — 24/09/2026

Usuário aprovou expressamente a publicação somente de 2A em origin/main. Revisão final confirmou que login.html preserva integralmente o antigo index.html (normalizando quebras de linha), e que alterações em cadastro/painéis se limitam aos textos e destinos de Login. Nenhuma migration criada ou alterada: permanecem 001–007. Sem mudanças em backend de Evolution, Mercado Pago, assinatura ou regras de agendamento.

Testes disponíveis reexecutados antes do commit: **116 aprovados, zero falhas, 1 ignorado**, saída 0. Treze arquivos exclusivamente dependentes de PostgreSQL (14 testes) foram excluídos desta execução por falta de TEST_DATABASE_URL; o teste misto de segmentos manteve suas verificações unitárias e ignorou a integração. Nenhum banco foi configurado, limpo ou alterado. Sintaxe dos JavaScripts alterados e git diff --check passaram.

Commit limitado à lista de arquivos de 2A documentada acima. Exclusões preexistentes de .codex/backups e painel/index.html permanecem fora do commit. Capturas, scripts de verificação/preview e logs ficam exclusivamente em .tmp/, ignorada pelo Git. A publicação não autoriza nem inicia 2B/2C.

### Nova conferência da prévia — 24/09/2026

Prévia local reiniciada em `http://127.0.0.1:3022` usando o servidor estático existente, sem conexão com banco ou integrações. A apresentação solicitada já estava implementada ao iniciar esta conferência. Foram inspecionadas novas capturas da primeira dobra, smartphone, conversa, agendamento, dashboard, recursos, segmentos, preços e menu em desktop e celular. Proposta explícita e smartphone completo na primeira dobra de 1366×768; no celular, proposta e CTAs aparecem antes do smartphone. Dados ilustrativos e aviso de trial em preparação permanecem visíveis.

Alteração adicional desta conferência: `backend/public/studiofy-home.css`, ampliando para pelo menos 44 px as áreas de toque do menu, seus links em telas menores, controle de reprodução do smartphone e botão Voltar da demonstração. Este documento também foi atualizado. HTML, JavaScript e testes preexistentes foram preservados nesta conferência.

Novas evidências em `.tmp/etapa2a-final/`: páginas completas `landing-1366.png`, `landing-1440.png` e `landing-390.png`; primeiras dobras, capturas de cada seção, fluxo confirmado, detalhes mobile e menu; `visual-report.json` e `all-tests.log`. Verificação de 320, 390, 768, 1024, 1366 e 1440 px sem overflow horizontal, erros JavaScript, requisições externas ou operações de escrita durante o tour.

Suíte completa executada novamente após o ajuste: **131 testes, 116 aprovados, 14 falhas de preparação por ausência de TEST_DATABASE_URL, 1 ignorado pelo mesmo motivo**; código de saída 1. Os testes de navegador da landing passaram. Banco não foi configurado ou alterado. `git diff --check` e sintaxe de `studiofy-home.js` passaram. Sem commit, push, deploy ou avanço para 2B/2C. Aguardando aprovação.

Revisão solicitada antes de publicar, realizada na prévia `http://127.0.0.1:3022`. A primeira dobra anterior tinha 967 px de altura no notebook; o smartphone terminava abaixo dos 918 px e o CTA ficava fora da primeira tela de 768 px. O novo layout mantém a proposta, os botões e o smartphone inteiro visíveis em 1366×768: limite inferior do telefone em aproximadamente 673 px e dos CTAs em 641 px.

Alterações desta revisão, preservando a implementação anterior:

- `backend/public/index.html`: proposta explícita “Agendamento + WhatsApp + gestão do estabelecimento”; CTA “Teste grátis por 7 dias”; percurso visual em sete momentos, incluindo recebimento no estabelecimento e confirmação/lembrete para o cliente; conversa natural; indicadores de Clientes e Serviços mais realizados; revisão dos textos de preços, mantendo condições claras e sem ativar trial.
- `backend/public/studiofy-home.css`: primeira dobra compactada, smartphone completo e legível, espaçamentos e tipografia; novos cartões de recebimento/entrega e percurso visual; ajustes responsivos e de legibilidade dos números/gráficos.
- `backend/public/studiofy-home.js`: personalização da conversa somente na landing, sem modificar a demonstração compartilhada de Login/Cadastro; confirmação fictícia atualiza os cartões do estabelecimento e do cliente, com lembrete ilustrativo 20 minutos antes do horário selecionado. Reiniciar restaura o exemplo. Nenhuma consulta de disponibilidade real, reserva, envio ou persistência.
- `backend/test/landing-browser.test.js`: teste da primeira dobra em notebook e verificações do recebimento fictício, horário do lembrete e reinício do exemplo; preservadas verificações de isolamento de rede e navegação.
- `STUDIOFY-ETAPA2.md`: registro desta revisão e das evidências.

A simulação continua usando somente dados fictícios, com rótulos visíveis. O telefone da primeira dobra é uma ilustração independente; o agendamento interativo sincroniza a conversa e os cartões da seção Demonstração. O único acesso de rede do script da landing continua sendo GET da configuração pública de preço. Os CTAs de teste levam ao aviso de preparação, sem iniciar cobrança ou conceder acesso. O cadastro pago existente permanece um link separado, com indicação explícita das condições.

Inspeção visual: primeira dobra, tamanho/posição do smartphone, conversa, percurso de agendamento e retorno ao estabelecimento, dashboard financeiro, recursos, seis segmentos e outros profissionais, preços, CTAs, menu e tipografia. Verificados 1366×768, 1440×900, 1024×900, 768×844, 390×844 e 320×844: sem overflow horizontal. Relatório de navegador: zero erros JavaScript, zero requisições externas, zero operações de escrita durante a captura e simulação.

Capturas novas em `.tmp/etapa2a-review/`, ignorada pelo Git:

- `primeira-dobra-1366.png` e `primeira-dobra-1440.png`;
- `landing-1366.png`, `landing-1440.png` e `landing-390.png` (páginas completas);
- `demonstracao.png`, `fluxo-confirmado.png`, `dashboard.png`, `recursos.png`, `segmentos.png` e `precos.png`;
- `mobile-smartphone.png`, `mobile-agendamento.png`, `mobile-dashboard.png`, `mobile-recursos.png`, `mobile-segmentos.png`, `mobile-precos.png` e `mobile-menu.png`;
- `visual-report.json`: dimensões e auditoria de requisições.

Suíte completa reexecutada após os ajustes finais com `npm.cmd test`: **131 testes contabilizados; 116 aprovados; 14 falharam na preparação por ausência de `TEST_DATABASE_URL`; 1 ignorado pelo mesmo motivo; nenhum cancelado**. Não houve outra falha. O comando retorna código 1 por essa dependência ausente; isso não equivale a homologação integral do PostgreSQL. Log: `.tmp/etapa2a-review/all-tests.log`. Sintaxe dos scripts alterados e `git diff --check` passaram.

Nenhuma alteração de banco, migrations, Evolution API, Mercado Pago, assinatura ou regras de agendamento. Nenhum commit, push ou deploy. O HEAD continua `99e0198`. **A revisão para aqui para aprovação do usuário; 2B e 2C não foram iniciadas.**
