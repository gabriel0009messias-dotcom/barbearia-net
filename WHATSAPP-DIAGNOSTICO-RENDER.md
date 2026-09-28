# WhatsApp: diagnóstico e publicação no Render

## Evidência de produção em 27/09/2026

Foram feitas consultas de leitura e login na conta sintética já existente. Nenhum connect, create, logout, deploy ou envio de mensagem foi executado.

- O `/health` do Studiofy informou o commit `d084080edae738677bdacefd21f7f0d96fb327a4`; o JavaScript publicado ainda tinha a contagem antiga e não tinha os novos diagnósticos.
- Na coleta iniciada às **19:54:42 UTC**, a raiz `https://evolution-api-3-bp28.onrender.com/` excedeu 25 segundos e `GET /api/publico/assinaturas/13/whatsapp/status` retornou **504, EVOLUTION_TIMEOUT**.
- Às **20:01:04 UTC**, a raiz voltou a responder **200**, versão **2.3.7**, em 740 ms. Na coleta das **20:01:17 UTC**, a mesma rota de status do Studiofy retornou **502, EVOLUTION_ENDPOINT_NOT_FOUND, upstreamStatus=404**.
- O registro local da validação anterior em produção (`.tmp/whatsapp-publish/smoke-result.json`) mostrava **429 já na primeira consulta de status**, antes de clicar em Conectar. Não guardava corpo nem endpoint upstream. Nesta investigação não houve novo 429 real; não é possível atribuir o 429 histórico ao status, webhook ou proxy sem seus logs.

O timeout seguido de recuperação pode indicar inicialização lenta ou indisponibilidade transitória. Não foi possível consultar os logs privados do Render nem confirmar plano, suspensão, consumo de recursos, Redis ou banco da Evolution. Esses pontos não foram tratados como causa comprovada.

## Falhas corrigidas e fluxo

A Evolution 2.3.7 informa ausência pelo texto `The "nome" instance does not exist`. O classificador antigo reconhecia apenas frases começando por `Instance` ou `The instance`, convertendo esse 404 em erro de endpoint. A consulta inicial falhava e a tela mantinha Conectar desabilitado. Agora esse formato oficial é reconhecido; um 404 genérico de rota continua sendo erro e não autoriza criação. A incompatibilidade foi reproduzida nos testes; sem o corpo do 404 real nos logs não é possível afirmar que ele veio desse guard.

Fonte: [guard oficial da Evolution 2.3.7](https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/api/guards/instance.guard.ts).

| Ação | Studiofy | Evolution |
| --- | --- | --- |
| Abrir seção, recarregar, Atualizar status ou polling | `GET /api/publico/assinaturas/:id/whatsapp/status` | Somente `GET /instance/connectionState/:instanceName`; nenhum create/connect |
| Clicar Conectar WhatsApp | `POST /api/publico/assinaturas/:id/whatsapp/iniciar` | Consulta estado; cria com `qrcode:false` somente após ausência confirmada; então `GET /instance/connect/:instanceName` uma vez |
| Estado ambíguo durante conexão explícita | Mesmo POST iniciar | Busca excepcional `GET /instance/fetchInstances?instanceName=...`; erro genérico não autoriza criar |
| QR obtido | Continuação da tentativa explícita | `POST /webhook/set/:instanceName`, em segundo plano |
| Confirmar desconexão | `DELETE /api/publico/assinaturas/:id/whatsapp/logout` | `DELETE /instance/logout/:instanceName` |

Outra falha corrigida: um 429 de status ou webhook apagava a tentativa ativa do guard, embora não comprovasse seu término. Agora preserva a tentativa, não autoriza novo connect e não apaga o QR já obtido quando apenas a consulta de status falha. A rejeição 429 do próprio connect permite nova tentativa explícita após o prazo. Timeout de connect continua sendo resultado incerto, sem repetição automática.

Consultas bem-sucedidas de status são compartilhadas por até dez segundos por instância; requisições simultâneas compartilham a operação em andamento. Connect e logout invalidam esse cache. O preflight de conexão explícita consulta o estado atual. Falhas não são armazenadas como sucesso.

Não foram encontrados múltiplos setInterval de WhatsApp no Studiofy: há um setTimeout de polling, um de contagem visual e o refresh geral de 30 segundos exclui a seção WhatsApp. Polling segue a cada 15 segundos durante tentativa, até três minutos/12 consultas, com backoff e parada após três falhas; 429 pausa imediatamente. Sair da seção/ocultar a aba cancela timers. Nenhum timer chama connect.

A coordenação é por processo Node. Para esta publicação, manter **uma instância do Web Service e um processo `npm start`**, sem cluster/PM2 ou réplicas. Coordenação entre múltiplos processos e persistência de tentativa após reinício exigiriam armazenamento compartilhado adicional; não foram introduzidas nem prometidas por esta correção.

## Diagnóstico que o backend entrega

Erros possuem `errorCode`, `rateLimitSource` e `diagnostic` com endpoint, instanceName, método, HTTP upstream, horário, requestId, tentativa e ação de origem. `httpStatus:null` significa que nenhuma resposta HTTP foi recebida, por exemplo timeout. A ação é a rota efetiva do backend; `trigger` é um rótulo informativo enviado pelo frontend, nunca autorização.

Nos logs, `evolution_upstream_429` contém esses campos e `body`, sanitizado e limitado a 1000 caracteres, com `bodyTruncated`. Chaves, tokens, QR e telefones não devem aparecer. O corpo upstream fica nos logs, não é exposto no navegador. No cooldown, `diagnostic` conserva a requisição que originou o 429; `rateLimitSource:local_cooldown` informa que não houve nova consulta upstream.

Para 503, 404 e timeout, buscar `request_failure` pelo requestId. Para a resposta HTTP recebida, buscar `request_response`. O header `X-Request-Id` identifica a requisição atual; em cooldown, a referência do erro pode ser de uma requisição anterior.

## Publicar somente o WhatsApp

O workspace também contém o bloqueio administrativo ainda local. **Não usar `git add .`** para esta publicação. O pacote `.tmp/whatsapp-render.patch` contém somente arquivos WhatsApp, com a parte de `backend/routes.js` separada das mudanças administrativas. Ele se baseia no commit publicado `d084080` e inclui as correções anteriores do WhatsApp que ainda não estavam em produção. Não inclui a migration 010 nem alterações administrativas. O pacote será acompanhado de sua conferência e testes.

1. No Render, serviço **barbearia-net → Settings → Auto-Deploy → Off**, para publicar o commit revisado manualmente.
2. Em um checkout limpo do repositório no commit `d084080edae738677bdacefd21f7f0d96fb327a4`, criar a branch e aplicar o pacote (substituir CAMINHO pelo caminho absoluto do patch):

   ```sh
   git switch -c fix/whatsapp-production d084080edae738677bdacefd21f7f0d96fb327a4
   git apply --check CAMINHO/whatsapp-render.patch
   git apply --index CAMINHO/whatsapp-render.patch
   git diff --cached --stat
   git diff --cached --check
   git commit -m "fix(whatsapp): diagnose upstream failures and preserve connection attempts"
   git push -u origin fix/whatsapp-production
   git rev-parse HEAD
   ```

3. Conferir no serviço do Studiofy: Root Directory `backend`, Build Command `PUPPETEER_SKIP_DOWNLOAD=true npm ci`, Start Command `npm start`, uma instância/processo. Conferir `EVOLUTION_API_URL` com a URL base correta, sem `/manager` ou `/instance`, e `EVOLUTION_API_KEY` correspondente ao serviço Evolution. Manter `EVOLUTION_API_RETRY_ATTEMPTS=1`. `EVOLUTION_STATUS_TRACE=true` é opcional; logs de 429 e falhas não dependem dessa opção.
4. **Deploys → Manual Deploy → Deploy a specific commit**: informar o SHA do passo 2. Esperar Live e conferir `/health`: `version` deve ser esse SHA. A opção apenas Restart service não publica código novo. Referência: [deploy manual no Render](https://render.com/docs/deploys#manual-deploys).
5. Abrir `studiofy.html` com DevTools, marcar Disable cache e recarregar. Em Network, confirmar `/studiofy-whatsapp.js?v=diagnostics-3`.

Nenhum destes passos foi executado automaticamente nesta tarefa. Se for desejado publicar também o bloqueio administrativo, isso é outra seleção de alterações e exige incluir sua migration; não misturar acidentalmente os pacotes.

## Validar e resolver a indisponibilidade em produção

1. No Render, abrir **Logs** do Studiofy e da Evolution lado a lado. Confirmar que a Evolution está Live e não presa em restart/deploy. Conferir seus logs de inicialização, banco, Redis e recursos. A raiz HTTP 200 sozinha não comprova que a instância conecta.
2. Se houver Shell disponível no Studiofy, executar **uma vez** `node scripts/diagnose-evolution.js NOME_EXATO_DA_INSTANCIA`. Usar o instanceName dos logs/Manager, sem adivinhar. Isso só consulta `connectionState`, não cria nem conecta. Sem argumento, preserva o diagnóstico anterior de DNS, raiz e fetchInstances. No plano Free, que não oferece Shell, usar os passos de navegador abaixo e os logs. [Limitações do Render Free](https://render.com/docs/free).
3. Abrir WhatsApp: deve haver somente GET status. Se a instância não existir no formato oficial, deve retornar desconectado e liberar Conectar, sem criar instância. Clicar Atualizar: somente estado; repetições próximas podem usar o cache e não chegar à Evolution.
4. Clicar **Conectar WhatsApp uma vez**. Filtrar `[Evolution API]` pelo requestId. Esperado: uma consulta de estado, criação apenas se ausência confirmada, no máximo um connect; webhook separado se houver QR. Não apagar instâncias existentes para contornar erro.
5. Escanear o QR. Confirmar estado conectado. Recarregar página e clicar Atualizar: contagem de `/instance/connect/` não pode aumentar. Duplo clique/segunda aba durante tentativa também não deve iniciar outro connect no mesmo processo.
6. Se vier **429**, ler `evolution_upstream_429`: endpoint, instanceName, action/trigger, HTTP, body, headers `server`, `via`, `cf-ray`, `rndr-id` e Retry-After. Correlacionar horário/requestId com Evolution/proxy. Se o evento indicar `/webhook/set`, foi a configuração de webhook, não o connect. Se indicar `/connectionState`, foi a leitura. Corrigir a política/quota no componente que respondeu; não remover cooldown nem repetir connect em loop. Durante cooldown, não deve aparecer um novo evento upstream.
7. Se vier **504/EVOLUTION_TIMEOUT** ou **503/EVOLUTION_OFFLINE**, resolver inicialização, disponibilidade, DNS ou falha de banco/Redis no serviço Evolution conforme seus logs. No Free, o Render suspende após 15 minutos ociosos e a retomada pode levar cerca de um minuto; conferir se isso se aplica antes de atribuir a causa. Manter o serviço acordado permanentemente exige configuração/plano apropriado, não polling agressivo. Não foi confirmada suspensão neste caso.
8. Se vier **404 genérico/EVOLUTION_ENDPOINT_NOT_FOUND**, conferir URL base, versão e roteamento do proxy. Apenas a resposta específica de instância ausente é normalizada para desconectado. Se vier **401/403 da Evolution**, corrigir a chave no servidor; não é expiração do login Studiofy.

Critério de conclusão em produção: QR entregue, escaneamento concluído, estado conectado, reload e atualização sem novo connect, e ausência de novas chamadas durante cooldown. Testes com provedor simulado não substituem essa etapa.
