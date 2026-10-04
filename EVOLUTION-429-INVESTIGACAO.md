# Investigação local do HTTP 429 — Studiofy / barbearia-6

Data: 04/10/2026. Trabalho local concluído para revisão. Não houve commit, push, deploy, alteração de Environment ou acesso ao banco de produção. Nenhuma chamada foi enviada às URLs de produção; nenhuma instância real foi modificada, desconectada, excluída ou reiniciada.

## 1. Conclusão e confiança

O responsável exato pelo 429 **ainda não está provado**. Considerando o relato confirmado fornecido pelo usuário, o HTTP 429 é recebido pelo transporte do Studiofy ao chamar a origem da Evolution. O 502 é a transformação posterior feita pela rota temporária. O cooldown do Studiofy é um segundo mecanismo, local, que pode bloquear chamadas seguintes sem fazer HTTP.

A hipótese prioritária é **um intermediário HTTP ou middleware adicional à distribuição oficial da Evolution**, com confiança **baixa**. O texto puro `Too Many Requests\n` e `Retry-After: 30` são compatíveis com essa hipótese, mas não são uma assinatura exclusiva de produto ou fornecedor.

| Camada candidata | Evidência e limite |
| --- | --- |
| Studiofy: transporte | Não fabrica uma resposta HTTP de `fetch`. Reconhece `response.status === 429` e registra cooldown. Confiança alta na distinção entre upstream e bloqueio local, baseada no código e nos testes. |
| Studiofy: rota administrativa | Converte falhas em 502. Não contém limiter próprio e não faz retry de `/webhook/set`. |
| Studiofy: middleware/express-rate-limit | Há limiters do chat e das rotas públicas Studiofy. São inbound, em outros routers/paths; não interceptam o POST outbound nem a rota temporária, registrada antes desses routers. |
| Evolution oficial 2.3.7 | A busca de código não encontrou implementação de rate limit HTTP, status 429 ou o texto relatado. O caminho de webhook persiste configuração com Prisma e retorna JSON. Isso torna a implementação oficial examinada uma explicação menos provável, mas não certifica o artefato em produção. |
| Proxy/middleware externo ou distribuição modificada | Compatível com o formato observado; depende de headers e logs para confirmar. |
| Render | Não há evidência suficiente para atribuição. O plano Free e a documentação de rate limit da API administrativa Render não provam que um web service hospedado responde esse 429. |
| Cloudflare | Não há headers de produção disponíveis nesta investigação. `CF-Ray` ou `Server: cloudflare`, se aparecerem, indicam trânsito; não provam que Cloudflare gerou a resposta. |
| Biblioteca/dependência | Não foi encontrada dependência de rate limiter HTTP no manifest/lockfile oficial. `pg-cloudflare` aparece no lockfile como dependência de PostgreSQL; o nome não prova proxy Cloudflare. Não foi auditado integralmente o código instalado de cada dependência da Evolution em produção. |
| Cache local / Redis | O código de LocalCache é armazenamento NodeCache. Não contém geração de HTTP 429. A ausência de Redis não comprova a causa do problema. |

O bootstrap oficial responde erros com JSON `{status, error, response}`. O controller `WebhookController.set` executa `prisma.webhook.upsert`; o envio outbound de eventos (`emit`, com Axios) é outro caminho. Os guards de autenticação/instância usam erros 400/401/403/404/500. Nenhum desses caminhos examinados contém o produtor do texto puro relatado. Fontes primárias: [bootstrap oficial 2.3.7](https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/main.ts), [controller de webhook oficial](https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/api/integrations/event/webhook/webhook.controller.ts), [manifest oficial](https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/package.json).

A documentação [Render Free](https://render.com/docs/free) descreve suspensão, inatividade e limites de recursos, sem estabelecer que sejam a origem dessa resposta específica. A página [Rate Limiting da Render REST API](https://api-docs.render.com/reference/rate-limiting) trata da API administrativa, não do endpoint `/webhook/set` de um serviço hospedado.

## 2. Arquivos e caminhos analisados

Leitura dos caminhos relevantes e buscas de chamadas/limiters, sem ler arquivos de credenciais:

- `backend/evolutionApi.js`: transporte fetch, retries, redirecionamentos, status, criação/conexão/recuperação e configuração de webhook.
- `backend/evolutionConnectionGuard.js`: fila por instância, tentativas compartilhadas, cooldown e Retry-After.
- `backend/temporaryEvolutionWebhookAdmin.js`: autenticação, escopo fixo, concorrência, set/find e tratamento do 502.
- `backend/evolutionLog.js`, `evolutionContext.js`, `evolutionExistenceCache.js`: sanitização, correlação e caches.
- `backend/routes.js`: requireAdmin, registro da rota, fluxos de status/conexão/pairing e configuração automática de webhook.
- `backend/app.js`, `backend/src/app.js`, `backend/src/middlewares/errorMiddleware.js`: montagem, middleware e tratamento de erros.
- `backend/evolutionWebhook.js`: autenticação/ingestão dos eventos e worker de envio de mensagens. Não configura `/webhook/set` ao receber evento.
- `backend/whatsappWebhook.js`, `whatsappManager.js`: caminho local legado; busca dos pontos de integração HTTP/Evolution.
- `backend/src/services/evolutionApiService.js`, `whatsappService.js`, `backend/src/routes/whatsappRoutes.js`: adapter que compartilha o transporte e fluxos alternativos.
- `backend/chatRoutes.js`, `studiofyRoutes.js`, `services/chat.js`: limiters inbound e limitação de mensagens do chat.
- `backend/scripts/diagnose-evolution.js`, `configure-chatbot-webhooks.js`: diagnóstico e configuração em lote. Foram apenas inspecionados; não executados.
- `backend/public/studiofy-whatsapp.js`, `barbeiro.js`, `controle-interno.js`, `painel/src/services/api.js`: buscas dos pontos de fetch, polling, cooldown e repetição. Não foi encontrado chamador automático da rota temporária nesses arquivos.
- `backend/package.json`, lockfile e implementação instalada de `express-rate-limit`: dependências e formato padrão do limiter Studiofy.
- Testes `evolution*.test.js`, `temporary-evolution-webhook-admin.test.js`, `whatsapp.test.js`, `whatsapp-status-cooldown.test.js`, `studiofy-whatsapp.test.js`, `painel-whatsapp.test.js` e helper de PostgreSQL isolado.

O código da Evolution não estava presente como aplicação no workspace. Baixei somente a tag pública 2.3.7 para `.tmp/evolution-2.3.7-audit/evolution-api-2.3.7`. SHA-256 do ZIP: `77DE642649C7EFF86575A142C45BD028468ABBF72832F142A0AC4EF769B16DB9`.

Na cópia oficial: buscas em todo o source por `429`, `Too Many Requests`, `rateLimit`, `rate_limit`, `rate-limit`, `Retry-After`, `throttle`, `express-rate-limit`, `limiter`, `proxy` e `Cloudflare`; leitura de `src/main.ts`, `src/api/routes/index.router.ts`, guards de auth/instance/telemetry, `src/api/abstract/abstract.router.ts`, event router/controller, webhook router/controller, `src/cache/localcache.ts`, configurações de cache/proxy, telemetria e referências de proxy no canal WhatsApp. Manifest/lockfile também examinados. As buscas têm falsos positivos de identificadores, delimitadores e dependências; não foram considerados mecanismos de limitação.

## 3. Alterações desta investigação

O workspace já continha alterações anteriores. Foram preservadas. Este relatório descreve somente os incrementos desta investigação; o diff total do Git inclui trabalho anterior.

| Arquivo | Incremento |
| --- | --- |
| `backend/evolutionDiagnostics.js` — novo | Allowlist de resposta, leitura limitada, resumo seguro do corpo, metadados HTTP, classificação conservadora e projeção do retorno administrativo. |
| `backend/evolutionApi.js` | Opção interna `temporaryDiagnostics`; diagnóstico de erros HTTP da rota temporária; supressão de payloads de sucesso/erro e objetos Error nos logs desse modo; opção passada pelo configurador de webhook. |
| `backend/temporaryEvolutionWebhookAdmin.js` | Ativa o modo temporário em set/find e devolve `diagnostic` sanitizado no 502. |
| `backend/evolutionLog.js` | Amplia proteção de variáveis de conexão do banco para incluir `DATABASE_CONNECTION_URI` e nomes semelhantes. |
| `backend/test/evolution-temporary-diagnostics.test.js` — novo | Política de corpo, headers, segredos, erros HTTP, limites de leitura e classificação. |
| `backend/test/temporary-evolution-webhook-admin.test.js` | Mantém verificações de autenticação/escopo e acrescenta 429, contagem de chamadas, ausência de retry, headers e cooldown local. |
| `EVOLUTION-429-INVESTIGACAO.md` — novo | Este relatório. |

Artefatos auxiliares ficam em `.tmp`: cópia pública de código, logs de testes e script de limpeza dos schemas efêmeros do cluster de testes. Nenhum secret real foi utilizado nas simulações.

## 4. Segurança, limites e número de chamadas

A rota continua exigindo a sessão administrativa real via `x-admin-token`, retornando 401 para token ausente, inválido ou expirado. Continua rejeitando body com parâmetros e query strings; instância, URL, eventos e segredo não podem ser enviados pelo navegador. `EVOLUTION_WEBHOOK_SECRET` é obtido exclusivamente do Environment do servidor. Respostas de sucesso permanecem verificações booleanas, inclusive comparação do segredo com timingSafeEqual.

Nos erros, a resposta continua HTTP 502 e acrescenta somente `diagnostic`. Não retorna API key, webhook secret, stack trace, request payload, credenciais ou headers completos. O modo rigoroso é habilitado apenas pela rota temporária: os demais fluxos preservam seu comportamento e diagnóstico anteriores, com o reforço geral para variáveis de URI do banco.

Allowlist explícita de headers de resposta:

```text
retry-after, content-type, server, via, cf-ray, cf-cache-status, date,
x-request-id, request-id, rndr-id,
x-render-origin-server, x-render-routing, x-render-request-id,
x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset,
x-ratelimit-policy, x-ratelimit-reset-after,
ratelimit, ratelimit-policy, ratelimit-limit, ratelimit-remaining, ratelimit-reset
```

Cada valor passa pela sanitização antes do limite de 256 caracteres. Não há wildcard `X-Render-*`: um header arbitrário como `X-Render-Secret` não é considerado seguro. `Authorization`, `Cookie`, `Set-Cookie`, `apikey` e todos os headers não permitidos são descartados.

O resumo de corpo tem limite de 256 caracteres; a leitura para diagnóstico para após 8 KiB ou 1 segundo. Corpo excessivo, incompleto ou com erro é omitido. Só mensagens públicas previamente enumeradas são preservadas, inclusive `Too Many Requests`. Em JSON, apenas uma mensagem pública reconhecida é extraída; todos os outros campos são omitidos. HTML e texto arbitrário são omitidos, mesmo quando poderiam passar por uma regex de redação. Isso evita depender exclusivamente de reconhecimento de nomes de campos privados.

Por chamada administrativa: **no máximo um POST** `/webhook/set/barbearia-6`. Se esse POST retornar 429, não há retry nem GET de verificação: uma única chamada upstream. Em sucesso, o comportamento existente continua sendo POST seguido de um GET `/webhook/find/barbearia-6`; após verificação bem-sucedida, chamadas seguintes no mesmo processo fazem apenas GET. Portanto, a garantia não significa uma única chamada total no caso de sucesso. Redirects permanecem manuais, sem reenvio automático.

Durante cooldown, pode haver zero chamadas upstream. O guard calcula o máximo entre Retry-After e backoff local (30, 60, 120, 240, até 300 segundos). Um bloqueio local não é uma nova resposta upstream 429 e não renova o cooldown só por ser consultado. Esperar mais de 30 segundos pode ainda ser insuficiente para o cooldown local acumulado; isso não explica por si só novos 429 reais recebidos após longas esperas.

O lock `busy` e o cooldown são por processo, não distribuídos. Outros pedidos de conexão/pairing e o script de configuração em lote podem fazer POSTs independentes de webhook. O worker periódico usa envio de mensagens, não `/webhook/set`. Não foi alterado nenhum desses fluxos, nem foram executados scripts que configuram outras instâncias.

## 5. Diagnóstico da próxima tentativa

Se uma próxima chamada autorizada receber novamente 429 upstream, o navegador receberá um objeto deste formato. Exemplo ilustrativo com os dados relatados; headers adicionais aparecerão somente se realmente recebidos e permitidos:

```json
{
  "autorizado": true,
  "configuracaoAplicada": false,
  "verificacaoConcluida": false,
  "diagnostic": {
    "httpStatus": 429,
    "statusText": "Too Many Requests",
    "requestId": "<uuid da tentativa>",
    "timestamp": "<data ISO da tentativa>",
    "method": "POST",
    "endpoint": "/webhook/set/barbearia-6",
    "origin": "https://evolution-api-3-bp28.onrender.com",
    "durationMs": 0,
    "upstreamRetryAfter": "30",
    "body": "Too Many Requests",
    "bodyTruncated": false,
    "bodyOmitted": false,
    "classification": {
      "probableOrigin": "upstream_application_or_intermediary",
      "confidence": "low",
      "evidence": [],
      "producerConfirmed": false
    },
    "headers": { "retry-after": "30" }
  }
}
```

`durationMs` será medido, e `statusText` pode ser vazio dependendo da resposta HTTP. O log correspondente será `evolution_temporary_upstream_error`, com os headers permitidos como campos individuais. Evidências possíveis: `cloudflare_in_path`, `render_in_path`, `proxy_in_path`, `rate_limit_headers_present`. Nenhuma confirma o produtor sozinha.

Se a chamada for impedida localmente, o retorno terá `httpStatus: null`, `upstreamRetryAfter: null`, classificação `studiofy_local_cooldown` e `retryAfterSeconds` local. Não reutiliza headers de uma resposta anterior como se fossem uma nova resposta. Em falha de rede/configuração sem resposta HTTP, a classificação é `no_upstream_response`. Uma resposta 2xx inválida conserva o status recebido com `upstream_response_without_safe_details`, sem devolver seu conteúdo arbitrário.

## 6. Testes e resultados

- Suíte completa final: `node --test test/*.test.js`, em PostgreSQL exclusivo em loopback, verificado por `SHOW data_directory` dentro de `.tmp/trial-validation-pg/data`. **409 testes passaram; 0 falhas, cancelados ou skips; aproximadamente 87,1 segundos.** Log: `.tmp/evolution-429-audit-full.log`. A execução completa anterior também passou com 409 testes.
- Rota real + módulo temporário: `node --test test/temporary-evolution-webhook-admin.test.js test/evolution-temporary-diagnostics.test.js`: **13 passaram; 0 falhas**. Log: `.tmp/evolution-429-audit-route.log`.
- Verificação adicional final do módulo, incluindo limite do valor de headers: **3 passaram; 0 falhas**.
- Diagnóstico anterior de 429 e módulo novo: execução inicial conjunta com **17 testes aprovados**.
- Sintaxe dos módulos alterados e `git diff --check` dos arquivos versionados pertinentes passaram.

Cobertura: um POST e nenhum retry em 429 mesmo com tentativas configuradas para 9; nenhuma requisição durante cooldown; Retry-After; headers seguros; ausência de headers sensíveis e API key/webhook secret/Authorization/Cookie/Set-Cookie; limites e omissão de corpo; falhas/timeouts de leitura; outros status 400/401/403/404/500/502/503/504; proteção admin real, expiração e concorrência; rejeição de parâmetros enviados pelo cliente; comportamento existente de verificação do webhook.

Uma execução focada inicial foi interrompida após uma asserção detectar a barra final em `origin`, deixando a espera de um teste de concorrência sem término. A representação foi corrigida e a limpeza de cooldown foi movida para o hook do subteste. As execuções posteriores, inclusive a suíte completa, passaram. O único schema de teste residual dessa interrupção foi removido exclusivamente do cluster local verificado; a checagem final encontrou zero schemas efêmeros restantes.

Ambiente de execução local: Node 24.14.1; o projeto declara Node 20.x. Não foi executada uma validação adicional em Node 20. Todas as chamadas a Evolution dos testes foram mocks ou servidores HTTP locais. Nomes de instâncias presentes nas regressões são fixtures, sem contato com instâncias de produção.

## 7. O que ainda não pode ser provado e riscos

- Não foi capturada nova resposta de produção. O status/body/Retry-After relatados são o contexto fornecido pelo usuário.
- Não há prova de que o container em produção corresponda exatamente à tag pública oficial: faltam digest da imagem, commit/build e inventário de middleware/proxy do serviço efetivamente executado.
- Não há logs correlacionados da Evolution, edge ou Render para mostrar onde a solicitação foi rejeitada.
- Headers podem ser acrescentados ou alterados por intermediários; sua ausência não exclui uma camada, e sua presença não prova autoria.
- O diagnóstico é temporário e conservador: omitir HTML/texto arbitrário reduz detalhes disponíveis, de forma intencional, para evitar dados privados.
- A alteração de logs fica no caminho administrativo temporário; não representa uma certificação de todos os logs de todos os sistemas/dependências.
- Locks por processo não garantem exclusão entre múltiplas réplicas, outros aplicativos ou clientes que compartilhem instância/API key/IP de saída.
- Uma nova chamada à rota pode aplicar configuração de webhook se tiver sucesso, como já fazia antes. Esta investigação não executou essa ação em produção.

## 8. Próximos passos, após revisão

1. Revisar os incrementos locais e este relatório. Nenhum commit/deploy foi feito ou iniciado.
2. Se a revisão posteriormente autorizar disponibilizar o diagnóstico, fazer uma única chamada administrativa para `barbearia-6`, respeitando o cooldown efetivo e sem scripts em lote.
3. Guardar somente o JSON sanitizado e o log correspondente; correlacionar requestId, Date, IDs upstream/Render/Cloudflare e horário com os logs do serviço Evolution/infraestrutura.
4. Conferir em modo somente leitura a identidade do artefato Evolution executado e seu bootstrap/middleware. Confirmar se o POST chegou à aplicação. A falta de um log isolado não prova que não chegou, caso o acesso não seja registrado.
5. Se necessário, apresentar ao suporte do provedor apenas IDs/horários e headers sanitizados. Não encaminhar chaves, payload de configuração, cookies ou Environment.
6. Confirmar o produtor do 429 com evidência correlacionada antes de propor mudança de plano, cache, proxy ou rate limit. Depois da investigação, remover o diagnóstico temporário e a rota conforme revisão específica.

O trabalho está parado para revisão, conforme solicitado.

## Preparacao para producao, sem commit

O script .tmp/evolution-429-test-cleanup.cjs foi removido fisicamente. Nenhum arquivo de .tmp, log, ZIP ou codigo de terceiros faz parte do commit proposto. O indice Git continua vazio.

Lista exata proposta: backend/evolutionDiagnostics.js; backend/evolutionApi.js (somente incrementos do diagnostico); backend/evolutionLog.js (somente redacao de URI); backend/temporaryEvolutionWebhookAdmin.js; backend/routes.js (somente registro da rota temporaria); backend/test/evolution-temporary-diagnostics.test.js; backend/test/temporary-evolution-webhook-admin.test.js; EVOLUTION-429-INVESTIGACAO.md.

Como ha alteracoes anteriores no workspace, o pacote foi preparado sobre uma copia de HEAD, selecionando apenas os trechos necessarios. Nao inclui mudancas anteriores de guard, contexto, recovery, UI, banco ou pagamentos. O registro da rota em routes.js precisa entrar porque ainda nao esta em HEAD.

Revisao: nenhum segredo real hardcoded. As credenciais literais dos testes sao fixtures sinteticas. No caminho administrativo temporario, valores de AUTHENTICATION_API_KEY, EVOLUTION_WEBHOOK_SECRET, Authorization, Cookie, Set-Cookie e DATABASE_CONNECTION_URI nao sao registrados nem retornados ao navegador. Payloads de sucesso tambem sao omitidos dos logs. Os testes simulam inclusive eco dos segredos em headers permitidos.

HTTP 429 no POST /webhook/set/barbearia-6: no maximo uma tentativa desse POST, nenhum retry e nenhum GET posterior. Cooldown local: zero chamadas upstream. O fluxo de sucesso pode fazer POST seguido de GET de verificacao.

Testes desta preparacao: suite completa do workspace, 409 aprovados, zero falhas/cancelados/skips (92,4 s), log .tmp/evolution-429-precommit-workspace.log; suite completa da copia isolada de HEAD mais pacote proposto, 331 aprovados, zero falhas/cancelados/skips (76,1 s), log .tmp/evolution-429-precommit-isolated-full.log; testes finais da rota e modulo no workspace, 13 aprovados, zero falhas, log .tmp/evolution-429-precommit-final-targeted.log.

A copia isolada tem menos testes por excluir outros trabalhos ainda nao versionados. O teste de cooldown agora simula a passagem do tempo, sem depender de funcao de limpeza nao versionada. A espera de concorrencia tem prazo maximo. A suite isolada completa passou apos essas correcoes.

Nao houve staging, commit, push, deploy, alteracao de Environment ou chamada a producao. Trabalho aguardando autorizacao do usuario.

## Integracao com main antes do push

A main remota avancou para 1a42252d4262f6ed26e7b29ccd40862384b70eda antes desta publicacao. O pacote foi integrado em copia isolada, preservando esses commits. O registro da rota em backend/routes.js ja estava presente nessa base remota; por isso esse arquivo nao precisa de uma nova alteracao no commit final. O staging inicial sobre a base local teve os oito arquivos autorizados, e o diff final sobre main altera somente sete deles. Nenhum arquivo fora da lista autorizada foi acrescentado.

Validacao final sobre main integrada: node --test test/*.test.js, 359 testes aprovados, zero falhas/cancelados/skips, aproximadamente 80,9 segundos. Todas as chamadas upstream dos testes usam mocks ou HTTP local.
