# Correção da integração WhatsApp / Evolution API

Auditoria e implementação local em 03/10/2026. Nenhum deploy, alteração de credenciais ou exclusão de instâncias foi realizado. Alterações anteriores do workspace foram preservadas.

## Diagnóstico antes das alterações

O caminho real deste checkout é `backend/`, equivalente aos arquivos `src/backend/` citados no relato. `render.yaml` inicia `backend/app.js`, que monta `backend/routes.js` em `/api`.

O cliente principal já possuía fila por instância, single-flight de status, reserva de conexão, cache opcional e cooldown com backoff. Essas proteções foram mantidas; `evolutionConnectionGuard.js` foi auditado e não precisou de novas alterações nesta tarefa.

Foram encontradas estas falhas locais:

1. A consulta de abertura da seção usava cache de 10 segundos, mas iniciar QR/pairing consultava novamente sem aproveitar esse cache. Pedidos consecutivos podiam aumentar a carga apesar do single-flight para pedidos simultâneos.
2. `backend/src/services/evolutionApiService.js` possuía outro transporte, sem o guard principal, com retries automáticos inclusive para 429. Esse cliente pertence ao servidor alternativo `src/server.js`; não é o entry point definido no blueprint atual do Render. Portanto, sua existência não comprova que causou o incidente em produção.
3. `painel/src/App.jsx`, usado pelo servidor alternativo, fazia polling com `setInterval` de três segundos. Uma consulta lenta podia se sobrepor à seguinte.
4. O webhook processava apenas mensagens e ignorava `QRCODE_UPDATED` e `CONNECTION_UPDATE`. A configuração não assinava eventos de QR. A Evolution 2.3.7 retorna o QR disponível depois de uma espera curta no connect; `connectionState` retorna estado, sem recuperar o QR tardio. Uma tentativa sem QR podia permanecer reservada e sem código visível.
5. Configurar o webhook somente após receber um código deixava sem cobertura justamente as tentativas cuja resposta inicial não continha QR.
6. A confirmação HTTP de mensagens aguardava a entrega da fila. Uma Evolution lenta ou indisponível podia atrasar o ACK e provocar reentregas. A idempotência persistente de mensagens já existia e foi preservada.

O erro `rateLimitSource: upstream` prova que o Studiofy recebeu HTTP 429 da Evolution ou de um intermediário. Não prova qual componente aplicou esse limite. No entry point atual não há limitador geral sobre `/api/webhook/evolution`, e o processamento do webhook não chama `connectionState`. A origem do 429 de entrada relatado não foi reproduzida no checkout; exige comparar a versão publicada e os proxies com o ambiente local.

## Mapa das consultas e timers

| Origem | Comportamento auditado / resultado |
| --- | --- |
| `evolutionApi.obterEstadoConexao` | Único transporte de `connectionState` após a unificação; compartilha requisição em andamento por URL e instância. |
| `routes.garantirInstanciaWhatsapp` | Consulta de estado antes de QR/pairing; agora aproveita cache de 10 segundos. Criação permanece restrita a ausência comprovada. |
| `routes.consultarStatusWhatsappEvolution` | Usado por status e rotas antigas de QR; status da tela usa cache de 10 segundos. GET de QR não inicia connect. |
| `src/services/whatsappService` | Status e início do servidor alternativo agora usam o mesmo cliente e cooldown. Erros não são devolvidos como sucesso com estado antigo. |
| `public/studiofy-whatsapp.js` | Uma consulta na abertura da seção; polling sequencial durante tentativa, intervalo inicial de 15 segundos, até 12 consultas / três minutos. Pausa em 429 e retoma por atualização manual após o prazo. |
| `public/barbeiro.js` | Polling de 15 segundos já protegido por flags de requisição; agora exibe QR/pairing recebidos em resposta de status. |
| `painel/src/App.jsx` | Polling alternativo substituído por `setTimeout` sequencial de 15 segundos, limite de 12 consultas, trava síncrona de clique e respeito ao Retry-After. |
| Refresh geral do painel legado | Timer de 30 segundos; as flags de visibilidade e requisição protegem a consulta de WhatsApp. |
| `src/jobs/statusSyncJob.js` | Sincroniza assinaturas, sem chamadas de WhatsApp; preservado. |
| Webhook de conexão / QR | Atualiza estado e código diretamente a partir do evento autenticado; nenhuma consulta ao provedor. |

## Correções implementadas

- Dois clientes usam o mesmo transporte, fila, single-flight, cache e cooldown por instância. Env/API key e diagnósticos sanitizados permanecem no backend.
- Status simultâneos compartilham inclusive o erro upstream original. Pedidos posteriores durante cooldown não chegam à Evolution. Retry-After em segundos/data e backoff existente de 30 a 300 segundos foram preservados.
- Envios de mensagens também respeitam a fila e o cooldown da instância, evitando insistência da fila durante um limite já conhecido.
- Eventos de conexão/QR exigem o segredo existente e uma associação única da instância ao estabelecimento no banco. Eventos repetidos recebem 200; a deduplicação considera o último evento do tipo, permitindo transições legítimas `close → open → close`.
- Estado de webhook é publicado no cache somente após o commit no banco. Eventos locais são ordenados por instância. Respostas antigas de consultas e de connect não sobrescrevem a confirmação mais recente recebida por webhook.
- QR/pairing ficam em memória por até 60 segundos, sem logs de conteúdo. `open`, logout e invalidação de existência limpam o código. O QR inicial também pode ser recuperado durante sua validade.
- Webhook de mensagens responde depois de persistir a fila; o worker existente entrega as mensagens. Falha de envio não vira falha do ACK HTTP. Deduplicação persistente por mensagem e lease de entrega continuam ativos.
- Configuração de webhook ocorre antes do único connect e assina apenas `MESSAGES_UPSERT`, `CONNECTION_UPDATE` e `QRCODE_UPDATED`, com `byEvents: false`.
- Nenhum caminho novo exclui, reinicia ou recria uma instância existente. Timeout/429 não autorizam criação.

## Arquivos alterados nesta tarefa

Implementação:

- `backend/evolutionApi.js`
- `backend/evolutionWebhook.js`
- `backend/routes.js` — apenas integração e rotas WhatsApp/webhook
- `backend/public/studiofy-whatsapp.js`
- `backend/public/barbeiro.js`
- `backend/src/services/evolutionApiService.js`
- `backend/src/services/whatsappService.js`
- `backend/src/routes/whatsappRoutes.js`
- `painel/src/App.jsx` — componente WhatsApp e import de useRef
- `painel/src/services/api.js` — propagação de Retry-After

Testes novos: `backend/test/evolution-centralized.test.js` e `backend/test/evolution-webhook-connection.test.js`.

Testes ajustados: `backend/test/evolution-api.test.js`, `backend/test/studiofy-whatsapp.test.js` e `backend/test/whatsapp.test.js`. Os ajustes verificam os três eventos do webhook, a configuração antes de connect, a expiração do cache antes de simular outro erro e o QR tardio recebido pelo webhook real.

## Fluxo final

1. Abrir WhatsApp consulta somente o estado, com single-flight e cache curto.
2. Clicar Conectar trava o botão e inicia uma tentativa compartilhada por instância.
3. O backend reaproveita o estado recente, reutiliza a instância existente e configura seu webhook.
4. Executa uma única vez `GET /instance/connect/barbearia-6`; pairing usa a mesma rota com `?number=...`.
5. Mostra o QR inicial ou o QR tardio recebido por webhook. O polling consulta somente estado, sem novos connects.
6. O scan gera `open`; webhook persiste a conexão e alimenta o cache. A próxima resposta da tela mostra conectado, limpa o QR e encerra polling.
7. Em 429, o backend mantém o cooldown por instância e a tela pausa. O prazo respeita Retry-After; sua expiração não dispara outro connect automaticamente. Atualizar status permite retomar a verificação.

## Resultado dos testes

Validação final: **389 testes passaram, 0 falhas, 0 ignorados**, em aproximadamente 146 segundos.

Antes do commit e push, a correção foi aplicada em um checkout isolado da `main` remota, mantendo os commits `8c7657f` e `d04411d` já publicados e excluindo alterações locais de outras funcionalidades. Nessa versão exata, os **128 testes de WhatsApp passaram, sem falhas ou testes ignorados**. O commit contém 16 arquivos; diagnóstico, guard e contexto já estavam no remoto e não precisaram de novas alterações.

Comando executado em `backend/`: `node --test --test-concurrency=2 test/*.test.js`, usando PostgreSQL exclusivo de testes em loopback, porta 55449, com schemas temporários isolados. Log: `.tmp/evolution-final-full.log`.

`npm.cmd run build` em `painel/` também passou. `git diff --check` dos arquivos alterados passou.

Os testes novos verificam: clientes compartilhando uma consulta simultânea; cache e expiração; 429 compartilhado e cooldown sem novas chamadas; Retry-After; recuperação após prazo; fila de mensagens respeitando cooldown; QR tardio; resposta antiga versus evento open; open durante connect; close legítimo após open; autenticação e isolamento do webhook; concorrência de eventos repetidos; 140 reentregas com HTTP 200; mensagem duplicada persistida apenas uma vez e ACK antes do envio externo. O teste de navegador foi atualizado para exibir QR recebido pelo webhook real. Os testes existentes cobrem cliques repetidos, QR/pairing, open/close, timeout/indisponibilidade, backoff, isolamento de contas e ausência de exclusão automática.

As primeiras execuções identificaram expectativas antigas de cache e ordem do webhook; foram corrigidas e reexecutadas. O primeiro build foi impedido pela leitura de diretórios no sandbox; a execução local com permissão ampliada passou. Nenhum teste precisou ser desativado.

## Verificações manuais no Render / Evolution

O blueprint local confirma `EVOLUTION_API_RETRY_ATTEMPTS=1`, timeout de 20 segundos e `EVOLUTION_SYNC_FULL_HISTORY=true`. Isso é configuração do repositório, não leitura das variáveis efetivas dos serviços publicados.

- Verificar que a versão publicada corresponde a esta correção e que a URL base aponta à raiz da Evolution, sem `/manager` ou `/instance`.
- No Manager da `barbearia-6`, conferir o webhook para `https://<dominio-studiofy>/api/webhook/evolution`, enabled, `byEvents=false`, eventos `MESSAGES_UPSERT`, `CONNECTION_UPDATE`, `QRCODE_UPDATED` e header `x-webhook-secret` igual ao segredo existente no backend. Nenhuma chave precisa ser enviada ao navegador.
- Verificar se webhook global e webhook da instância enviam os mesmos eventos ao mesmo destino. Usando webhook por instância para este destino, evitar duplicação global. A 2.3.7 possui caminhos independentes de entrega local/global.
- Conferir filtros de eventos globais: histórico, presença, contatos e chats não são necessários para este fluxo. `syncFullHistory=true` pode aumentar tráfego na sincronização inicial; avaliar desligá-lo nas configurações da instância se o histórico não for necessário. Não foi alterado automaticamente.
- Manter backoff de retries de webhook. A 2.3.7 trata 429 como repetível por padrão; não mascarar o problema adicionando 429 à lista de erros sem retry.
- Verificar limite de requisições do serviço/proxy da Evolution e do proxy de entrada do Studiofy. Correlacionar `requestId`, endpoint, timestamp, headers HTTP e logs `evolution_upstream_429` já sanitizados. Raiz respondendo 200 não garante que endpoints autenticados estejam fora de limite.
- Conferir `DEL_INSTANCE=false` na Evolution para evitar expiração automática de instâncias desconectadas.
- A coordenação de status, QR e cooldown é por processo Node. Manter uma réplica/processo para este modelo; múltiplas réplicas exigem coordenação distribuída. A deduplicação de mensagens e a fila de entrega continuam persistentes no PostgreSQL. Deduplicação de eventos de conexão/QR é local por 60 segundos; após restart/repetição, as operações são atribuições de estado idempotentes.

Não houve validação de scan com WhatsApp real ou acesso administrativo à configuração publicada. O 429 externo não pode ser declarado eliminado por testes com Evolution simulada. Foram corrigidas as fontes locais de carga redundante e o QR tardio; um limite externo ainda pode exigir ajuste manual.

## Fontes oficiais conferidas

- [Rotas da Evolution 2.3.7](https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/api/routes/instance.router.ts): connect e connectionState usam GET.
- [Controller da instância 2.3.7](https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/api/controllers/instance.controller.ts): connect retorna QR disponível; connectionState retorna estado.
- [Controller de webhook 2.3.7](https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/api/integrations/event/webhook/webhook.controller.ts): entregas local/global e retries.
- [Configuração de referência 2.3.7](https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/.env.example): eventos globais, retries e DEL_INSTANCE.
