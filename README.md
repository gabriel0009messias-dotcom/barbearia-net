# Salaoflix - sistema de barbearias

O servidor iniciado por `npm start` e pelo Render e `backend/app.js`, com Express, PostgreSQL e as paginas HTML/JavaScript em `backend/public/`.

Os arquivos em `backend/src/` e `painel/src/` pertencem a uma base alternativa com PostgreSQL/React. O fluxo de pagamentos documentado aqui usa o servidor atual; nao troque o comando de inicializacao.

## Pagamentos

O unico provedor de cobranca e Mercado Pago, via Checkout Pro. O cadastro cria uma assinatura pendente; o checkout cobra o valor registrado no banco (R$ 65 para novos cadastros). Uma confirmacao autenticada consulta o pagamento no Mercado Pago antes de liberar 30 dias de acesso. Nao ha debito recorrente automatico: cada renovacao e paga pelo checkout.

Veja [MERCADO-PAGO.md](MERCADO-PAGO.md) para variaveis do Render, webhook, testes e consultas ao banco.

## Executar

Na pasta backend:

```sh
npm install
npm start
```

Configure DATABASE_URL e abra http://localhost:3000. As migrations PostgreSQL sao aplicadas na inicializacao ou com `npm run migrate`. Consulte [POSTGRESQL-RENDER.md](POSTGRESQL-RENDER.md) para importar o SQLite local sem altera-lo.

Para pagamentos, configure um endereco HTTPS publico em PUBLIC_APP_URL e as credenciais descritas no guia. Sem elas, o servidor inicia, mas nao gera checkout.

## Testes

```sh
cd backend
npm test
```

Defina TEST_DATABASE_URL para um PostgreSQL exclusivo de testes. Cada suite cria e remove somente seu schema temporario.

No PowerShell com scripts bloqueados, use `npm.cmd test`. Os testes usam bancos temporarios e APIs simuladas, sem cobrar ou enviar mensagens reais.

## Render e persistencia

O `render.yaml` instala o backend e executa `npm start`, servindo tambem as paginas de `backend/public/`. Configure DATABASE_URL com a Internal Database URL do PostgreSQL na mesma regiao. Nao e necessario disco persistente no Web Service. O SQLite local foi preservado e serve como origem de importacao. Veja [POSTGRESQL-RENDER.md](POSTGRESQL-RENDER.md).

Com Root Directory `backend`, use Build Command `PUPPETEER_SKIP_DOWNLOAD=true npm ci` e Start Command `npm start`. O frontend real foi movido de `painel/` para `backend/public/`, sem alterar seu conteudo, para ficar dentro do diretorio publicado. Nao depende de Vite nem de `painel/dist`. Os dois pontos de entrada do Express resolvem o caminho a partir de `__dirname`, servem `/` como `index.html` e mantem as rotas da API. O servidor alternativo `src/server.js` conserva sua API propria; para o fluxo atual de cadastro, pagamentos e WhatsApp, mantenha `npm start`.

## WhatsApp

O funcionamento do atendimento esta documentado em [WHATSAPP-AGENDAMENTO.md](WHATSAPP-AGENDAMENTO.md). Suas configuracoes e credenciais sao independentes das de pagamento.

## Exclusao de contas no controle interno

Em `/controle-interno.html`, entre com o login administrativo e use **Excluir** na linha da conta. A exclusao exige confirmacao e remove a assinatura e seus dados vinculados em uma unica transacao: servicos da conta, agendamentos, bloqueios, sessoes, tokens de recuperacao, mensagens e registros locais de pagamentos. As outras contas e os cadastros compartilhados de clientes e servicos sao preservados.

Se a operacao falhar no banco, a transacao e desfeita. Se houver falha de conexao, recarregue a lista para conferir o resultado antes de tentar novamente. A migration `003_account_delete_relations.sql` e aplicada automaticamente na inicializacao. A exclusao de registros locais nao realiza estornos no Mercado Pago nem remove instancias na Evolution API.

## Liberacao manual de acesso

A lista **Assinaturas cadastradas** mostra apenas clientes com pagamento aprovado e creditado pelo backend ou com registro de liberacao manual. Cadastros sem pagamento continuam no banco e seguem para o checkout normalmente. Pedidos e pagamentos pendentes, rejeitados ou em processamento nao incluem novos clientes na lista. Clientes pagos continuam visiveis durante uma renovacao pendente; registros antigos com confirmacao, ID e data de pagamento tambem sao preservados na listagem.

Os cadastros sem aprovacao e sem liberacao manual ativa aparecem na secao **Cadastros aguardando pagamento**, com dados de contato, forma de pagamento, data do cadastro e acoes para liberar dias ou excluir com confirmacao. A visualizacao nao libera login. As duas secoes sao classificadas a partir da mesma consulta e atualizadas a cada 30 segundos enquanto o painel estiver visivel e sem alteracoes de status aguardando salvamento. Aprovacao do pagamento ou liberacao manual move o cliente para **Assinaturas cadastradas**; quando uma liberacao manual expira sem pagamento, o cadastro volta para os pendentes, sem prorrogar o acesso. A busca **Liberar acesso por e-mail** tambem continua disponivel.

No controle interno, **Liberar dias** concede de 1 a 365 dias de acesso sem pagamento, contados a partir de agora. A lista mostra a data e a hora de termino. Um prazo manual mais longo ja concedido e preservado. Selecionar **Ativo** e salvar uma conta inativa tambem abre essa opcao; salvar uma conta ja ativa apenas informa seu estado.

A liberacao e exclusiva do administrador, fica registrada nas observacoes e nao altera pagamentos nem o vencimento da cobranca. Ao expirar, o acesso volta a seguir a situacao da assinatura, inclusive a tolerancia normal de atraso. Para encerrar a liberacao antes do prazo, selecione **Bloqueado** e clique em **Salvar**. A migration `004_manual_access.sql` adiciona o prazo na inicializacao do servidor.
