# Etapa 2B — Trial de 7 dias

Implementação local concluída para revisão. **Atualização da validação: 231 testes aprovados, zero falhas e zero ignorados com PostgreSQL local isolado**, conforme [STUDIOFY-ETAPA2B-VALIDACAO.md](STUDIOFY-ETAPA2B-VALIDACAO.md). O registro abaixo descreve a entrega inicial e a limitação de banco então existente, agora resolvida. Sem deploy, push, execução de migration em produção ou implementação de 2C.

## Revisão dos arquivos interrompidos

- `backend/database/migrations/008_seven_day_trial.sql`: compatível com as migrations 001–007. Adiciona `trial_ends_at TIMESTAMPTZ`, `trial_status` nullable e `trial_claims`. Não contém DROP, limpeza, backfill nem alteração de assinaturas existentes. Datas TEXT legadas são preservadas. Contas anteriores ficam com `trial_status = NULL`, sem elegibilidade automática.
- `backend/services/trial.js`: conectado à transação de cadastro. Início e fim são gerados uma única vez pelo relógio do PostgreSQL, com precisão de milissegundos e intervalo de 168 horas. A avaliação usa o relógio do servidor e recusa datas inconsistentes. O início exige atualização de exatamente uma conta elegível; qualquer falha reverte também o cadastro e as reivindicações de identidade.

O fluxo ativo continua em `backend/routes.js`, `backend/studiofyRoutes.js` e `backend/public`. Nenhuma implementação alternativa foi criada em `backend/src` ou `painel`.

## Autenticação e autorização

`backend/services/access.js` reúne a avaliação de assinatura existente, tolerância de vencimento, acesso administrativo e trial. Retorna `trial_active`, `trial_expired`, `subscription_active` ou `payment_required`, além de `liberado`, mensagem e informações de prazo.

As regras de vencimento foram extraídas do router existente. Assinatura paga e liberações administrativas continuam prevalecendo; o motivo distingue a tolerância existente. Um pagamento anterior impede reutilizar o trial após o período pago ou estorno.

Login valida credenciais e cria sessão independentemente do pagamento. Consultar a sessão não a remove por expiração do trial. Os middlewares operacionais exigem autorização após autenticar a conta, inclusive nos endpoints antigos de agenda, bloqueios, faturamento e WhatsApp e em todas as rotas privadas do Studiofy.

Continuam acessíveis: login, logout, recuperação de senha, dados da própria conta, status de acesso, configuração de planos e checkout. O checkout mantém a validação de senha ou sessão pertencente ao estabelecimento. Nenhuma rota permite ao cliente editar datas ou reiniciar o trial.

Os identificadores normalizados de e-mail e telefone são registrados por hash na tabela `trial_claims`, inclusive para impedir nova concessão após exclusão e recadastro com os mesmos contatos. Não há verificação de titularidade dos contatos nem garantia contra alguém que apresente identidades inteiramente novas.

## Cadastro, expiração e pagamento

Cadastro novo começa o trial e faz login no Studiofy sem chamar o checkout. O trial não cria vencimento de cobrança: o fluxo existente do Mercado Pago define o período pago quando confirma a aprovação.

A aprovação continua usando a integração e webhook existentes, incluindo conciliação e idempotência. O estado pago libera a próxima operação, inclusive com a sessão que estava bloqueada pelo trial expirado. Não foi criado outro gateway nem alterado o cálculo do período contratado.

Expiração não apaga conta, serviços, clientes ou agendamentos. Página pública e novas reservas ficam indisponíveis sem autorização. Consulta e cancelamento público de reservas já existentes continuam disponíveis pelos tokens individuais. Lembretes que chegam ao momento de envio sem autorização são marcados como cancelados, preservando o registro. Respostas automáticas de WhatsApp deixam de ser criadas e a fila pendente aguarda autorização para enviar. Reservas futuras permanecem armazenadas.

## Frontend

Landing e cadastro apresentam “7 dias grátis” e “Sem cartão para começar”, com avisos de indisponibilidade removidos. O painel apresenta término e dias restantes fornecidos pelo backend. Ao expirar, mantém a sessão e mostra “Seu teste grátis terminou. Seus dados continuam salvos.”, “Ver planos” e “Assinar Studiofy”.

O painel permite gerar o checkout existente e consultar novamente a liberação. Preços de contratos antigos são preservados na apresentação da assinatura. Nenhuma decisão de autorização usa localStorage ou relógio do navegador.

## Testes e evidências

Comando de regressão: `npm.cmd test`, em `backend`.

- 136 testes contabilizados: **120 aprovados, 14 falhas por ausência de TEST_DATABASE_URL e 2 pulados pela mesma dependência**.
- Nenhuma outra falha na execução final. Log local: `.tmp-trial-regression.log`.
- Testes direcionados de Landing, painel e regras de trial também passaram. Log local: `.tmp-trial-targeted.log`.
- Verificações de sintaxe dos scripts alterados e `git diff --check` passaram.

Cobertura adicionada ou atualizada:

- Limites exatos de 168 horas, datas inválidas, assinatura ativa, vencimento e liberação manual.
- Cadastro com datas adulteradas; login durante e após trial; logout/login sem reinício.
- Operações protegidas negadas depois da expiração, mantendo conta, status e checkout acessíveis.
- Tentativa de alterar outro estabelecimento e datas do próprio trial; repetição com contatos formatados de outra forma e rollback do cadastro.
- Preservação de serviços e reservas; ausência de trial retroativo; assinatura legada ativa sem trial.
- Webhook aprovado libera uma sessão com trial expirado; notificações duplicadas mantêm a idempotência existente.
- Migration 008 preserva todos os campos anteriores e não concede trial à conta usada no teste de upgrade.
- Navegador: cadastro entra sem checkout; painel mostra prazo, preserva sessão após expiração e permite pagamento; Landing oferece trial real, inclusive sem JavaScript.

Os testes que dependem do banco foram implementados, mas **não tiveram suas asserções integradas executadas** neste ambiente. Isso inclui cadastro transacional, migration, isolamento e webhook com persistência real. A execução integral ainda exige PostgreSQL exclusivo de testes configurado em `TEST_DATABASE_URL`.

O backend aplica migrations no startup conforme o mecanismo já existente. Nesta sessão ele não foi iniciado com o banco configurado de produção; não foi executado `migrate`. Migrations 001–007 e a integração do Mercado Pago permanecem intactas.

Entrega encerrada na 2B para revisão.
