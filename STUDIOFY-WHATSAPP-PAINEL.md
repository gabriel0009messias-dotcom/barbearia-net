# WhatsApp no painel Studiofy — implementação local

## Escopo

Item **WhatsApp** imediatamente abaixo de Agendamentos e acima de Conversas. A seção apresenta **Conectar WhatsApp**, estado da conexão, QR responsivo, instruções, atualização manual e desconexão com confirmação. Mantém a identidade visual e a navegação existentes.

Arquivos desta implementação:

- `backend/public/studiofy-whatsapp.js`: ciclo de vida da tela, estado, QR, confirmação e limites de consulta.
- `backend/public/studiofy-whatsapp.css`: estilos restritos à seção e ao diálogo.
- `backend/public/studiofy.html`: carregamento dos módulos.
- `backend/public/studiofy.js`: menu, montagem/desmontagem e exclusão da seção do refresh geral de 30 segundos.
- `backend/routes.js`: número conectado e QR opcional presentes na resposta já obtida; ID da sessão como fonte das três operações existentes.
- `backend/test/studiofy-whatsapp.test.js`: navegador, API real e PostgreSQL isolado, com Evolution simulada.
- Este relatório.

Sem nova integração, migration ou alteração em `evolutionApi.js`, `evolutionConnectionGuard.js`, `evolutionExistenceCache.js` ou módulos do Chat Studiofy. Nenhum commit, push ou deploy.

## Integração reutilizada

Rotas existentes: `POST /api/publico/assinaturas/:id/whatsapp/iniciar`, `GET /api/publico/assinaturas/:id/whatsapp/status` e `DELETE /api/publico/assinaturas/:id/whatsapp/logout`.

`requireBarbeiro` autentica e aplica o acesso da Etapa 2B. O parâmetro da URL precisa coincidir com a sessão; o ID usado para carregar a conta vem de `req.assinatura.id`. Campos como `establishment_id` e `instanceName` enviados no corpo não controlam a instância.

Identificação/criação continuam em `garantirInstanciaWhatsapp`, respeitando sessão persistida e nome derivado da conta. Ausência comprovada é necessária para criar instância. `compartilharGeracaoQr` e `connectOnce` continuam protegendo chamadas concorrentes, abas e tentativas incertas. Status não chama `/connect`. Logout reutiliza a função existente e não remove tabelas ou dados do chat.

`connectedNumber` é opcional, extraído somente de `ownerJid` ou `number` fornecidos pela Evolution para a instância consultada. Não usa o telefone cadastrado como se fosse o número conectado. Nenhuma consulta adicional foi introduzida para obter o número. QR retornado no payload de estado também pode ser exibido sem reiniciar a conexão.

## Controle de chamadas

- Entrar na seção consulta status uma vez; não inicia conexão. Fora da seção, o módulo não consulta WhatsApp.
- Conectar exige clique explícito e status conhecido. Operações são serializadas no frontend; tentativa ativa oculta o botão de conectar.
- Durante uma tentativa: somente status, a cada 15 segundos, por até três minutos e no máximo 12 consultas automáticas. Falhas transitórias aumentam o intervalo para 30/60 segundos e param após três falhas.
- 429 interrompe imediatamente o acompanhamento e limpa o QR. A interface respeita o maior prazo entre `Retry-After`, `retryAfterSeconds`, `retryAt` e 30 segundos. O cooldown/backoff original do servidor permanece intacto.
- Contagem regressiva altera somente a tela. O fim do cooldown não dispara requisição: o usuário precisa atualizar o status. O prazo permanece ao sair e retornar à seção; recarregar a página continua protegido pelo guard do servidor.
- Sair da seção, pagehide ou aba oculta interrompe consultas agendadas. Voltar à visibilidade não inicia requisição sozinho; Atualizar status permanece disponível.
- Tempo limite ou resultado incerto não autoriza repetir `/connect`. A tentativa só é encerrada por estado confirmado ou desconexão explícita.
- Desconectar exige confirmação em diálogo; Cancelar/Escape não envia requisição.

Mensagem de 429: **“O WhatsApp está temporariamente indisponível. Aguarde alguns minutos antes de tentar novamente.”**

## Segurança e privacidade

Token da sessão enviado em cabeçalho, sem credenciais Evolution no navegador. Dados variáveis são renderizados por `textContent`; a imagem aceita os formatos de imagem base64 e a URL HTTPS do gerador já usado pela integração. QR e número não são gravados em localStorage ou logs do novo módulo. O token do painel segue o mecanismo preexistente.

O Chat Studiofy mantém seus próprios endpoints, sincronização e estado, sem dependência da tela WhatsApp. A suíte comprova leitura e resposta do chat enquanto o provedor simulado retorna 429.

## Validação e limites

Testes específicos: **15 aprovados / 0 falharam / 0 ignorados**. Cobrem menu, estado desconectado, conexão, cliques duplicados, outra aba, QR inicial e pendente, atualização manual, número conectado/ausente, confirmação de logout, isolamento A/B, IDs forjados, prazo máximo, backoff, cooldown entre seções e independência do chat.

Na primeira execução, o teste de QR pendente identificou que a nova leitura opcional não considerava a imagem dentro de `instance`. O backend foi corrigido para reconhecer ambos os níveis do payload; o teste permaneceu exigindo exibição sem novo connect e passou.

Inspeção visual em **1440×1000, 390×844 e 360×844**, sem overflow horizontal da página e com QR quadrado dentro da largura disponível. Screenshots somente em `.tmp/studiofy-whatsapp-preview/`; o desenho usado pelo provedor simulado é uma fixture, sem sessão WhatsApp real.

Limites: conexão com aparelho real não foi realizada; produção não foi consultada ou alterada. Número só aparece quando o provedor o fornece. Se uma tentativa não disponibilizar QR pela resposta inicial nem pelo status, a tela não força `/connect`: permite conferir status ou desconectar com confirmação antes de outra tentativa. Mantido o gerador de imagem QR já existente na integração para payloads não-base64. A coordenação do guard existente é local ao processo Node.

Backups e `painel/index.html` preexistentes permanecem fora desta alteração.

## Ajustes finais de revisão — 27/09/2026

Menu responsivo: até 850px, os botões passam a ocupar múltiplas linhas, sem recorte horizontal. WhatsApp fica totalmente visível na posição inicial em 360px e 390px; todos os demais itens continuam acessíveis. A regra fica no CSS do módulo WhatsApp e não altera o menu desktop. A versão desse CSS no HTML foi incrementada para evitar cache antigo. Capturas em `.tmp/studiofy-whatsapp-preview/qr-1440.png`, `qr-390.png` e `qr-360.png`.

Limitação do estado Conectando: o contrato existente agrupa `connecting`, `pairing` e `syncing` em `iniciando`, e também pode retornar `pairing` para uma tentativa ainda pendente. Nenhum desses sinais comprova que o QR foi lido. A interface mantém **Preparando conexão...**, com instrução de escaneamento quando há QR, até a confirmação **🟢 WhatsApp conectado**. Não foi acrescentado um estado **Conectando ao WhatsApp...** baseado em tempo, desaparecimento do QR ou suposição de leitura. Distinguir essa fase exige um sinal inequívoco do provedor; nenhuma nova integração ou consulta foi criada.

Os 15 testes específicos passaram, com verificações adicionais da ordem dos cinco primeiros itens, limites de todos os botões do menu, visibilidade integral do WhatsApp no viewport mobile inicial e ausência de inferência de leitura do QR a partir de `connecting`. A primeira execução das novas asserções falhou por dois erros de edição da automação (`$eval` em vez de `$$eval` e acento corrompido no texto esperado); corrigidos sem relaxar as verificações. Não eram falhas do produto.

Regressão completa após o ajuste: **318 aprovados / 0 falharam / 0 ignorados**, zero cancelados, saída 0. Específicos: **15 aprovados / 0 falharam / 0 ignorados**. Previews revisados em 1440px, 390px e 360px. PostgreSQL separado verificado pelo diretório, zero schemas temporários após execução e cluster encerrado. Nenhuma conexão real Evolution, acesso a produção, alteração da Etapa 2C, commit, push ou deploy nesta revisão.
