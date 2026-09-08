# Conexao do WhatsApp por codigo

O fluxo publicado usa Evolution API com a integracao `WHATSAPP-BAILEYS`.
O Baileys e suas credenciais ficam no servico Evolution; este backend nao deve
criar outro socket nem carregar Chromium para gerar pairing code.

## Falhas corrigidas

- `configurarWebhookEvolutionSePossivel` acessava `valores`, `campos` e `params`
  fora do escopo. Com `PUBLIC_APP_URL` configurada, a conexao falhava antes de
  solicitar o codigo. A gravacao de `whatsapp_numero` foi movida para a funcao
  de persistencia correta.
- O cliente reconhecia apenas um formato de `fetchInstances`. Agora reconhece
  tambem `name` e `instanceName` da Evolution v2, reutilizando a instancia.
- Criar a instancia iniciava a conexao imediatamente. Agora a criacao usa
  `qrcode: false`; o connect recebe o numero antes de iniciar o pareamento.
- O fluxo fazia logout de sessoes em `connecting`. Agora consulta o resultado
  pendente e nunca desconecta automaticamente uma sessao existente.
- O status podia usar WPPConnect local enquanto o pareamento usava Evolution.
  Com Evolution configurada, ambos usam o mesmo provedor. Em hospedagem,
  configuracao ausente produz erro explicito, sem iniciar navegador local.
- Consultas redundantes e tentativas com timeout de 90 segundos acumulavam
  minutos de espera. A geracao tem prazo total de 60 segundos e uma tentativa
  HTTP por etapa; o status tem limite de 12 segundos. O navegador cancela a
  geracao apos 70 segundos e o status apos 15 segundos.
- Erros da Evolution nao sao confundidos com login expirado do salao.
  Respostas malformadas, falhas SQL e indisponibilidade recebem mensagens
  uteis; logs incluem assinatura, etapa, HTTP, codigo do erro e stack.
- O auto refresh sobrescrevia a apresentacao da conexao. O codigo e as
  instrucoes agora permanecem visiveis. O polling nao sobrepoe consultas,
  termina ao conectar, apos tres falhas ou apos tres minutos.
- Na inicializacao com banco vazio, updates consultavam colunas antes do
  termino dos `ALTER TABLE`. O servidor agora aguarda as migracoes existentes.

## Contrato e uso

As rotas continuam exigindo `x-barbeiro-token` e conferem a assinatura do login.

`POST /api/publico/assinaturas/:id/whatsapp/pairing-code` aceita
`{"phone":"75983179933"}` ou o campo legado `numero`. O numero fica
`5575983179933`. Numeros nacionais com DDD 55 tambem sao tratados corretamente.

Uma resposta com codigo contem `success: true`, `status: "pairing_code"`,
`connected: false`, `code` e `pairingCode`. Se ja conectado, retorna
`status: "connected"`, `connected: true` e nenhum codigo.

`GET /api/publico/assinaturas/:id/whatsapp/status` retorna `disconnected`,
`pairing` ou `connected`, com `success`, `connected` e `message`.
Falhas retornam `success: false`, `status: "error"`, `message` e HTTP adequado:
401 para login ausente, 403 para acesso negado, 404 para assinatura ausente,
500 para erro interno, 502/503 para falhas do provedor e 504 para timeout.
Instancia ainda inexistente e um estado desconectado normal, nao um erro 500.

O cliente copia o codigo exibido no site e o digita no WhatsApp em
**Aparelhos conectados > Conectar um aparelho > Conectar com numero de telefone**.
O codigo nao e enviado por SMS. Nao registrar pairing codes, tokens ou telefones
completos nos logs.

O QR usa a rota existente `/whatsapp/iniciar`, como alternativa secundaria.
Solicitacoes simultaneas de metodos ou numeros diferentes recebem 409.
Na Evolution 2.3.7, uma instancia que ja esta em `connecting` devolve o
resultado existente. Se a tentativa foi iniciada por QR, o usuario pode usar
**Desconectar WhatsApp** antes de iniciar por numero. Nao ha logout automatico.

## Render e persistencia

`render.yaml` ja declara disco em `/var/data` e
`DATABASE_PATH=/var/data/barbearia.db`. A associacao entre assinatura, numero e
nome da instancia fica nesse SQLite. O banco local do usuario nao foi incluido
nas alteracoes. Em Render, falha de permissao do disco nao deve provocar troca
silenciosa para banco temporario.

As credenciais de autenticacao do WhatsApp ficam na **Evolution**, nao no disco
do painel. E necessario que o servico Evolution tenha seu banco persistente
configurado (`DATABASE_PROVIDER`, `DATABASE_CONNECTION_URI` e persistencia de
instancias conforme a versao). Este repositorio nao contem o deploy nem as
credenciais administrativas desse servico; sua persistencia real precisa ser
conferida no Render. Nao houve troca de biblioteca nem recriacao do banco.

No servico do painel, conferir `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` e
`PUBLIC_APP_URL`. O webhook e configurado com o envelope da Evolution v2 e
timeout curto, sem bloquear a entrega do codigo.

Na verificacao publica realizada nesta tarefa, a rota de status respondeu 401
sem token, confirmando que existe. A primeira consulta a raiz da Evolution
expirou em 20 segundos; a segunda respondeu HTTP 200 e versao 2.3.7. Isso nao
permite afirmar a causa da demora nem o erro autenticado da assinatura 1.
Nao houve acesso aos logs privados ou variaveis de producao do Render.

## Validacao

Executar `npm test` em `backend` (`npm.cmd test` no PowerShell com scripts bloqueados).
Os testes usam banco temporario vazio e Evolution simulada, nunca contas reais.
Cobrem autenticacao, isolamento, normalizacao, codigo atrasado/ausente,
conexao existente, QR, concorrencia, falha SQL, configuracao ausente e timeout.
Os testes do painel usam Chromium/Chrome headless quando disponivel
(`CHROME_PATH` pode informar o executavel). Validam codigo, instrucoes,
refresh, polling, erro e botao liberado apos timeout.

Tambem foi iniciado `app.js` com banco vazio isolado: a pagina respondeu 200 e
a rota protegida respondeu 401, sem erros de inicializacao. A vinculacao real
ao celular ainda exige publicar esta versao e concluir o pareamento no WhatsApp.

## Arquivos alterados

- `backend/routes.js`: geracao, status, autenticacao do WhatsApp e persistencia.
- `backend/evolutionApi.js`: contrato v2, instancias, prazos e diagnostico.
- `backend/database.js` e `backend/app.js`: ordem de inicializacao do banco.
- `painel/barbeiro.html` e `painel/barbeiro.js`: codigo, QR secundario, copiar,
  desconectar, mensagens, estados e polling.
- `backend/package.json`: comando de testes.
- `backend/test/whatsapp.test.js` e `backend/test/painel-whatsapp.test.js`: testes.
- `WHATSAPP-CONEXAO.md`: diagnostico, operacao e limites da verificacao.

Referencias primarias: [contrato de connect](https://docs.evoapicloud.com/api-reference/instance-controller/instance-connect),
[implementacao de instancias](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/controllers/instance.controller.ts)
e [persistencia da Evolution v2](https://github.com/EvolutionAPI/docs-evolution/blob/main/v2/en/requirements/database.mdx).
