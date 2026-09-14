# Atendimento automático pelo WhatsApp

## Qual backend recebeu a implementação

O `render.yaml` executa `npm start` (`backend/app.js`), agora usando PostgreSQL via `DATABASE_URL`. O atendimento, a agenda e as sessoes persistentes usam o mesmo banco do painel. A base alternativa em `backend/src/server.js` nao deve substituir esse comando.

## Arquivos

Alterados: `backend/app.js`, `backend/database.js`, `backend/evolutionApi.js`, `backend/evolutionWebhook.js`, `backend/routes.js`, `backend/botFlow.js`, `backend/whatsappWebhook.js`, `backend/package.json`, `backend/test/database-path.test.js`, `backend/test/evolution-api.test.js`, `render.yaml`.

Criados: `backend/services/whatsapp/chatbot.js`, `backend/services/whatsapp/scheduling.js`, `backend/services/whatsapp/sessionRepository.js`, `backend/scripts/configure-chatbot-webhooks.js`, `backend/test/chatbot.test.js` e este documento.

## Banco e migration

- Reutiliza `sessoes`, adicionando `data_json` para preservar etapa, opções exibidas e escolhas por salão/telefone.
- Reutiliza `agendamentos`, `bloqueios`, `servicos_assinatura` e endereço/expediente de `assinaturas`.
- Cria `whatsapp_messages`: identificação única da mensagem recebida, resposta pendente, tentativas e estado de envio.
- Substitui o índice global de horários pelo índice único `idx_agendamentos_tenant_horario`, considerando salão, data e hora para reservas confirmadas.
- As migrations PostgreSQL sao automaticas na inicializacao ou executadas por `npm run migrate`.
- A persistencia usa PostgreSQL; veja [POSTGRESQL-RENDER.md](POSTGRESQL-RENDER.md) para importacao dos dados antigos.

## Render e Evolution

1. No backend Render, mantenha `npm start` e as variáveis da conexão que já funciona: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `PUBLIC_APP_URL` e `DATABASE_URL`.
2. Adicione **`EVOLUTION_WEBHOOK_SECRET`**, um segredo aleatório longo. Não envie esse valor em mensagens ou o coloque no frontend.
3. Faça novo deploy do backend.
4. Localmente na pasta `backend`, com a External Database URL em `DATABASE_URL`, execute `npm run whatsapp:webhook`. Mantenha tambem as credenciais da Evolution e PUBLIC_APP_URL. O script configura as instancias existentes sem recria-las.
5. Novas conexões por QR ou código continuam configurando seu webhook pelo mecanismo existente; agora o header secreto também é incluído.

URL, usando o domínio configurado neste repositório:

```text
https://barbearia-net.onrender.com/api/webhook/evolution
```

Se mudou o domínio, use `https://SEU-DOMINIO/api/webhook/evolution` e ajuste `PUBLIC_APP_URL`.

Configuração na Evolution:

- Enabled: `true`.
- Eventos: **`MESSAGES_UPSERT`** e **`CONNECTION_UPDATE`**. O atendimento processa apenas o primeiro; o segundo não altera a conversa. Não é necessário ativar `SEND_MESSAGE`, histórico ou enquetes.
- By Events: `false` (sem sufixo na URL).
- Base64: `false`.
- Headers: `{"x-webhook-secret":"MESMO_VALOR_DE_EVOLUTION_WEBHOOK_SECRET"}`.

O script usa o formato v2 `{"webhook":{...}}` já empregado na conexão existente. A versão da Evolution publicada precisa aceitar headers personalizados. O endpoint recusa chamadas sem o segredo; configurar apenas a URL não basta. Veja a documentação oficial de [eventos](https://docs.evolutionfoundation.com.br/en/evolution-api/configuration/webhooks) e [headers do webhook](https://docs.evolutionfoundation.com.br/en/evolution-api/set-webhook).

## Fluxo e disponibilidade

Envie `Oi` de outro número para o WhatsApp conectado. Responda `1`, escolha um serviço, uma data, um horário, informe o nome e responda `1` ao resumo. Antes da confirmação nada é reservado. No `barbeiro.html`, o registro aparece como `confirmado` na atualização automática do painel.

O atendimento usa somente serviços daquele salão, intervalo de 30 minutos e janela dos próximos 14 dias, seguindo o modelo existente (não há duração por serviço ou configuração de horizonte no schema legado). Respeita expediente, almoço, dias fechados, bloqueios, reservas e horário atual em `America/Sao_Paulo`. A API `GET /api/disponibilidade?data=AAAA-MM-DD`, autenticada como o painel, e a gravação em `POST /api/agendamentos` compartilham esse serviço. O bot local também consulta essa disponibilidade.

`MENU`, `CANCELAR`, `RECOMEÇAR` e `0` abandonam a seleção atual e retornam ao menu; não cancelam uma reserva já confirmada. Para cancelar uma reserva, escolha `4` no menu e confirme a reserva selecionada. O status passa a `cancelado`, mantendo o histórico no painel e liberando o horário.

Estado da conversa, agendamento e resposta pendente são salvos na mesma transação. Mensagens repetidas não avançam novamente a etapa. Respostas com falha de envio ficam no banco e são tentadas novamente pelo worker, inclusive depois de reiniciar. Uma falha entre o aceite da Evolution e a gravação da confirmação de envio pode repetir o **texto** da resposta, mas não cria outro agendamento. Não há garantia de entrega exatamente uma vez oferecida pelo envio de texto.

Mensagens do próprio bot, grupos, broadcasts, eventos de histórico e envelopes inválidos são ignorados. LIDs só são usados quando há o telefone alternativo (`remoteJidAlt`); o sistema nunca trata o LID como telefone.

## Testes

Execute `cd backend` e `npm test` (`npm.cmd test` no PowerShell com scripts bloqueados). Os testes usam banco temporário e provedor simulado; não enviam mensagens a clientes reais.

Cobertura: cliente novo/conhecido, serviços/datas/horários, resumo e alterações, gravação consultada pela API do painel, disponibilidade compartilhada com o site, bloqueios, cancelamento simples/múltiplo, entradas inválidas, comandos, concorrência, duplicidade, persistência em outro processo, isolamento entre salões, autenticação, fuso horário, falha/reenvio e preservação de QR/código no painel.

Resultado local: **53 testes aprovados, nenhuma falha**. `git diff --check` também passou. O arquivo `backend/barbearia.db` já tinha alteração local antes do trabalho e foi preservado; os testes criaram seus próprios bancos temporários.

**Validação pendente em produção:** após deploy/configuração, faça o primeiro agendamento descrito acima; confirme no painel; confira de outro número que o horário desapareceu; cancele pelo WhatsApp; reinicie o backend durante uma seleção e prossiga. Não foi feito deploy nem envio real pela Evolution durante a implementação, e o funcionamento no Render não foi atestado por estes testes locais.
