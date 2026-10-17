# Agendamento conversacional por texto — etapa local

Base de implementação: `76254428e9b00bc144124284565441001650ddd1`.
Somente texto/números. Nenhuma integração de botão, lista ou enquete acrescentada.

## Operação e experiência

O webhook `/api/webhook/evolution` mantém sua autenticação e reconhecimento
durável, mas passa o evento de mensagem ao processador conversacional. Saudações
mostram menu de agendamento, preços, endereço e cancelamento. A conversa segue
serviço → profissional → dia → horário → nome → revisão → confirmação.

O cliente responde apenas `1`, `2` etc. ou informa seu nome, sem copiar referência,
token ou ID e sem precisar citar mensagens. A escolha pertence exclusivamente à
etapa e ao conjunto de opções atuais, lidos sob lock no PostgreSQL. A referência
aleatória permanece interna. `MENU`, `INÍCIO`, `RECOMEÇAR` e saudações reiniciam
somente o rascunho; `0` ou `VOLTAR` volta uma etapa e invalida escolhas dependentes.

Respostas explicitamente citadas usam o ID do provedor persistido na outbox
conversacional (ou texto exato quando só este contexto está disponível). Vínculo
antigo, desconhecido, ambíguo ou de outro remetente/tenant/epoch não é aplicado:
o bot orienta e reapresenta a pergunta atual. Uma entrada inválida também recebe
orientação e opções, preservando escolhas e tentativa de confirmação. Sem contexto
ou timestamp que demonstre atraso, um número é interpretado somente na pergunta
atual; não é possível inferir de qual pergunta antiga o cliente pretendia responder.

As páginas têm até oito opções; dias são apresentados por semana, dentro dos
90 dias permitidos pelo agendamento oficial. MAIS/ANTERIOR funcionam sem
referência. Um único profissional habilitado pode ser selecionado automaticamente;
zero profissionais nunca cria um profissional novo. O nome é solicitado no contexto
da conversa, sem presumir que um nome encontrado em outra reserva seja confiável.

## Persistência e segurança

Migration aditiva `021_whatsapp_conversations.sql`; 018, 019 e 020 preservadas.
Nenhuma sessão antiga é copiada e nenhum booking histórico é produzido.

- `whatsapp_conversations`: identidade tenant/instância/remetente, epoch de
  ownership, estado JSON, versão, referência, último prompt e expiração.
- `whatsapp_conversation_inbox`: recibo único instância/ID do provedor, tenant e
  epoch imutáveis pelo caminho da aplicação, fingerprint e decisão. Uma entrada
  aguardando entrega guarda temporariamente só texto/contexto normalizados
  necessários ao consumo; não guarda o payload bruto do provedor. Esse conteúdo
  é apagado ao concluir ou invalidar a entrada. Recibos não são apagados quando
  o rascunho expira.
- `whatsapp_conversation_actions`: tentativa e chave de booking geradas pelo
  servidor, corpo autorizado e vínculo permanente com a reserva do remetente.
- `whatsapp_conversation_responses`: vínculo de outbox com conversa/epoch/revisão.

A migration acrescenta epoch ao registro de ownership e marcador imutável à
outbox. Alterações apenas de status/reserva de transporte não mudam o epoch;
reassociação muda. O início da migration valida constraints deferidas pendentes
da instalação 018 antes do DDL e restaura o modo deferido; não desabilita guards.

A entrada usa o registro `evolution_instance_owners` e revalida a associação com
o resolver oficial, sob lock da origem seguido pelo registro. Nunca deriva nome
de instância pelo ID. Campos tenant/owner fornecidos no payload são ignorados.
O remetente vem exclusivamente do envelope autenticado; LID sem PN é rejeitado.

Transição, inbox, estado, ação e outbox usam a transação serializada já existente.
O estado é bloqueado no PostgreSQL. Um erro reverte tudo; a retransmissão pode
processar novamente somente quando o recibo não foi commitado. IDs repetidos ou
reutilizados com outro conteúdo não avançam o estado. Há proteção para recibos
do webhook antigo que já existem na outbox. Eventos com timestamp anterior à
revisão recebem orientação sem avançar; eventos excessivamente futuros são
ignorados. Um comando global sem timestamp/contexto é
tratado como nova intenção de reinício; não cria nem cancela booking.

Expiração: 30 minutos de inatividade, com `clock_timestamp()` do banco. Verificada
na entrada e antes do dispatch de prompts. A expiração descarta o rascunho ao
receber nova mensagem, sem depender de timer de limpeza. Recibos e ações não são
removidos automaticamente. Uma futura política de retenção deve preservar a
janela de deduplicação e a evidência de autorização.

## Booking e confirmação

Catálogo exclusivamente em `servicos_assinatura`, ativo e tenant corretos.
Profissionais/vínculos oficiais. Dias/horários exclusivamente via
`createStudio().times()`, incluindo duração, expediente, bloqueios e São Paulo.
Não há calendário nem catálogo paralelos. A consulta oferece disponibilidade
naquele instante; não reserva o horário durante a conversa.

Ao confirmar, locks nos mesmos registros de serviço, profissional e vínculo
precedem a comparação com a revisão. Nome, preço, duração ou profissional alterados
exigem revisão e consentimento novos. `confirmBooking()` usa a chave persistida
da tentativa e mantém os locks/trigger de conflito oficiais. Um savepoint permite
tratar conflito sem deixar a transação da inbox abortada. Estado COMPLETE,
recibo, booking, acesso privado e origem 020 commitam juntos.

O chatbot NÃO cria uma segunda mensagem final de sucesso: a origem/materializador
020 é seu único produtor. Sua mensagem permanece no formato publicado. A revisão
inclui profissional e duração. Snapshot 020, roteabilidade de telefone e seu
guard de imutabilidade permanecem intactos.

## Delivery

O transporte local legado foi desativado explicitamente (CONV-AUD-DELIVERY-03).
`botFlow.attachBotHandlers()` mantém um callback inerte para compatibilidade do
SDK: não chama API, não altera conversa/reserva e não envia mensagens.
`createMessageProcessor()` exportado também é inerte. Os helpers locais de texto,
botões, listas e enquetes perderam suas chamadas ao SDK. O processador interativo
antigo permanece privado, sem registro/export e sem capacidade de envio nesses
helpers. Nenhuma flag, token, instância, ambiente ou ID de evento reativa o envio.

`whatsappWebhook.sendMessage()` sempre informa `delivered:false` e
`LOCAL_MESSAGE_DELIVERY_DISABLED`; o endpoint legado ainda pode devolver o texto
na resposta HTTP, sem entregar WhatsApp. Os lembretes diretos do bridge
`wppconnect.js` e seu loop foram desativados; os workers oficiais permanecem.
Configuração/conexão local e seus testes existentes não equivalem a envio de
mensagem e permanecem compatíveis. O ambiente hospedado usa o ramo Evolution;
essa desativação também elimina a saída paralela no modo local/dev.

Não existe substituição por outro transporte direto nem segunda infraestrutura.
Texto/lista Evolution continuam exigindo o contexto de ownership oficial, e os
produtores ativos de respostas, confirmações 020 e lembretes usam a outbox e
`createEvolutionDelivery()`. Return Reminder permanece somente simulado nesta
etapa, sem transporte real. O inventário global A/B/C/D e a evidência dos testes
ficam no relatório QA externo ao pacote.

Respostas usam a outbox e o mesmo worker de 15 segundos, `createEvolutionDelivery`,
reserva de ownership, intenção durável e reconciliação existentes. Não há novo
timer nem transporte direto. Antes do transporte, um prompt deve continuar ligado
à revisão/ownership vigente e não estar expirado. Contexto ausente de uma mensagem
marcada conversacional falha fechado; o marcador não pode ser rebaixado.

Escolhas não avançam enquanto o prompt atual não estiver em `sent` (aceitação do
provedor; não é comprovação de leitura no aparelho). Se chegarem durante `pending`
ou `sending` (incluindo reserva e intenção de envio), ficam na inbox com decisão
`awaiting_delivery`, correlação da conversa/tenant/remetente/epoch, etapa, versão,
referência interna, ID da pergunta e ID/timestamp do evento. O recibo é único e
replay não cria nova pendência. A ordem de recebimento é uma identidade BIGINT
persistida; não depende de relógios, memória ou ordenação do ID do provedor.

O mesmo worker da outbox chama `consumePending()` antes da próxima busca de envio.
Depois de `sent`, o consumidor revalida toda a correlação sob os locks/transação
existentes e conclui inbox, transição, booking quando aplicável e nova outbox
atomicamente. Dois processos podem procurar a mesma entrada; só um a consome.
Se o processo morrer após a entrega, o próximo ciclo recupera a entrada sem
precisar de replay ou nova mensagem do cliente. O scan é limitado e seleciona
somente entradas prontas ou invalidáveis, sem repetir indefinidamente pendências
cuja entrega ainda não tem resultado seguro.

Dois eventos rápidos ligados à mesma pergunta não viram duas respostas a etapas
consecutivas. A primeira entrada avaliada gera transição ou orientação; depois
que a revisão muda, as demais ficam `pending_obsolete`. A nova pergunta já
produzida orienta o cliente; não se cria outra cópia dela para cada descarte.

Estados terminais incluem `processed`, `stale_revision`/`stale_event` (com orientação),
`pending_obsolete`, `pending_expired`, `pending_ownership_changed`,
`pending_missing_conversation`, `pending_payment_required`, `pending_identity_mismatch`
e `pending_delivery_failed`. Guardam `completed_at` e apagam `pending_event`.
Expiração não ressuscita rascunho; troca de tenant não redireciona entrada antiga.
Falha definitiva da pergunta encerra a pendência sem booking ou loop; não envia
orientação por um canal cuja entrega falhou. Quando a revisão mudou, a pergunta
nova fornece orientação. Para nova entrada após expiração, permanece o menu de
reinício já previsto.

`pending` e `uncertain` não autorizam avanço. `uncertain` mantém o protocolo
publicado: sem retry cego, sem
limpar fence automaticamente e sem fallback que provoque segundo envio. Um novo
menu pode ser enfileirado, mas não contorna uma entrega incerta anterior.
Uma reconciliação explícita como aceita (`sent`) permite reavaliar a pendência
no próximo ciclo; reconciliação rejeitada (`failed`) a torna terminal. Nenhum
caminho novo chama transporte diretamente ou altera a infraestrutura 018/019/020.

## Cancelamento

Implementado somente para reservas que possuem vínculo conversacional persistido
com o remetente, tenant e epoch atuais. A escolha usa opções do servidor, pede
confirmação e deriva internamente a capacidade privada da tentativa original;
`createPublicBookings().cancel()` aplica status, locks e antecedência oficiais.
ID, nome e telefone informados no texto não autorizam cancelamento.

Reservas externas ao fluxo não são recuperadas somente pelo telefone. O menu
orienta usar o acesso privado de cancelamento existente ou o estabelecimento.
Não solicitar nem registrar token privado no chat. Reassociação invalida o uso
dos vínculos antigos nesta conversa; nenhum vínculo é reassociado automaticamente.

## Verificação local

Testes permanentes em `test/whatsapp-conversation.test.js` e
`test/whatsapp-conversation-migration.test.js`, além de
`test/whatsapp-conversation-ux01.test.js` e
`test/whatsapp-conversation-reliability.test.js`, com fixtures sintéticas próprias.
Incluem dois processos, dois workers, concorrência de booking, escritor nativo
do catálogo, rollback transacional, migração/rollback, epochs, respostas obsoletas,
inbox, expiração, autorização de cancelamento e produtor 020 único.

Testes legados modificados somente para: expectativa nova de menu, lista da
migration 021, limpeza dos novos fixtures relacionados e comparação explícita
da metadata aditiva de epoch. Não foram alterados testes de chat público,
assertions de conflitos ou mecanismos 018/019/020 para ocultar falhas.

Todos os testes devem usar banco descartável, rede externa bloqueada e transporte
simulado. Esta entrega não valida a instância Evolution de produção nem resolve,
por si, o incidente de entrega real anteriormente relatado. Não realizar teste
real, commit, push ou deploy nesta etapa.
