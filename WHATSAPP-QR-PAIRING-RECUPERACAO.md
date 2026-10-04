# Recuperacao de QR e pareamento WhatsApp ? revisao de 60e48ba

## Diagnostico e evidencia

O codigo publicado tinha um caminho que reconhecia `connecting` ou uma tentativa reservada pelo single-flight e retornava `pending`, sem consultar novamente o codigo de conexao. O polling usava `connectionState`, que no controller oficial 2.3.7 retorna estado, e nao o QR. Quando o primeiro connect nao traz um codigo utilizavel e o webhook nao o entrega, esse caminho nunca recuperava o QR posterior. A interface interrompia o polling, mas preservava o titulo "Preparando conexao" e escondia a acao de tentar novamente. A tela tambem nao tinha formulario de pareamento.

Essa causa estrutural foi reproduzida em testes. A resposta REAL do connect de barbearia-6 em producao ainda NAO foi observada: este ambiente nao tem credenciais Evolution configuradas nem acesso aos logs Render. Nao e possivel afirmar se o primeiro response trouxe QR, count=0, ou outro payload. Foram solicitados logs sanitizados. `{count: 0}` e `{instance: {state: "connecting"}}` sao exemplos usados no simulador, nao respostas capturadas em producao.

O QR recebido por connect ou webhook fica em cache no processo do backend, com TTL local de 60 segundos. Nao e gravado como segredo duradouro no banco; reiniciar o processo perde esse cache. A resposta ao frontend normaliza QR/codigo e informa TTL, estado, modo e timeout. connectionState sozinho nao permite recuperar QR tardio.

## Contrato oficial Evolution 2.3.7

- QR e pareamento: `GET /instance/connect/{instanceName}`; pareamento usa `?number=5511999999999`, sem payload JSON. A API key vai no header `apikey` apenas entre backend e Evolution.
- Em `close`, connect inicia o socket e solicita pareamento com o numero informado. Em `connecting`, retorna o QR/codigo atual. Em `open`, retorna estado. Trocar QR por pareamento durante `connecting` nao gera novo codigo de pareamento no controller oficial: a aplicacao explica o conflito e preserva a tentativa.
- QRCODE_UPDATED inclui `data.qrcode.base64`, `code` e/ou `pairingCode`; CONNECTION_UPDATE inclui `state`. open e close sao valores desse evento.

Fontes verificadas:
- [Controller da tag 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/controllers/instance.controller.ts)
- [Rotas da tag 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/instance.router.ts)
- [Integracao Baileys da tag 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts)

## Implementacao

O backend inicia a tentativa com o single-flight existente e guarda codigos imediatos e posteriores. Sem codigo, durante connecting, permite ate tres leituras automaticas do endpoint oficial, espacadas por pelo menos 15 segundos, dentro de 60 segundos. Leitura e inicio sao distinguidos pelos testes conforme o estado oficial do controller. Cooldown, serializacao, Retry-After, cache e polling controlado foram preservados.

Sem codigo depois de 60 segundos, a tela sai de preparando e oferece Tentar novamente. QR/codigo expira localmente em 60 segundos; a recuperacao explicita consulta o estado novamente. Se ainda connecting, recupera o codigo atual; se close e a janela de espera terminou, permite uma unica tentativa solicitada pelo usuario na mesma instancia. Nao ha fallback de delete, recriacao, logout ou restart automatico. APIs da Evolution nao oferecem uma leitura de QR separada do connect: a recuperacao so o consulta apos observar connecting.

Disconnected mostra Conectar por QR Code e Conectar com codigo. Pareamento abre telefone e Gerar codigo, normaliza Brasil com DDI 55 (incluindo DDD 55) e aceita outros numeros internacionais com + ou 00. Exibe codigo e instrucoes e acompanha open. Durante requisicoes os controles ficam bloqueados. Desconectar aparece para open; tentativa pendente tem Encerrar tentativa como acao secundaria, com confirmacao explicita.

429 informa o tempo de espera e suspende requisicoes. Indisponibilidade informa erro amigavel. Webhooks autenticados atualizam cache e banco, processam QR/open/close e nao chamam connectionState. Os novos logs indicam somente estado, campos e presenca de codigos, sem registrar o QR ou pairing code.

## Arquivos deste incremento

- backend/evolutionApi.js
- backend/evolutionConnectionGuard.js
- backend/evolutionWebhook.js
- backend/routes.js (somente hunks WhatsApp pertencem a este incremento)
- backend/public/studiofy-whatsapp.js
- backend/public/studiofy-whatsapp.css
- backend/test/evolution-code-recovery.test.js (novo)
- backend/test/studiofy-whatsapp.test.js
- backend/test/whatsapp.test.js
- WHATSAPP-QR-PAIRING-RECUPERACAO.md

O workspace contem outras alteracoes anteriores. Elas precisam permanecer fora de um commit exclusivo desta correcao.

## Validacao

Suite completa: 396 testes aprovados, zero falhas, zero ignorados. Execucao em PostgreSQL exclusivo de testes e Evolution simulada, sem chamadas a producao. Log final: `.tmp/wa-full-final.log`.

Cinco novos testes unitarios cobrem QR tardio single-flight, ausente/timeout, expirado/retry close, pareamento tardio/conflito, 429/Retry-After/indisponibilidade. Dois novos cenarios de navegador cobrem pareamento brasileiro com clique duplicado e open, e ausencia/timeout/recuperacao/expiracao sem novo socket. Testes existentes foram atualizados para a leitura oficial de QR enquanto connecting; continuam cobrindo QR imediato, webhook QR/open/close, isolamento e nenhuma exclusao/recriacao de instancia existente.

## Configuracao e publicacao

Nenhuma configuracao Render/Evolution foi alterada e nenhuma instancia real foi consultada, desconectada ou excluida. A recuperacao limitada nao exige mudanca obrigatoria de configuracao. Para entrega por webhook, a URL publica e o segredo autenticado existentes devem estar corretos; isso ainda precisa ser confirmado nos logs de producao. Nao e necessario apagar barbearia-6.

O escopo esta validado para commit e teste controlado em producao. A resposta real e o funcionamento do provedor ainda dependem desse teste/logs. Nao houve novo commit, push ou deploy. Um push deve considerar que o Render pode publicar automaticamente; nesta etapa a instrucao foi nao fazer deploy.
