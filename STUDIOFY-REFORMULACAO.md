# Studiofy — implementação local

## Estrutura analisada e reaproveitamento

O caminho ativo é `backend/app.js` → `backend/routes.js` → PostgreSQL em `backend/database/`. O frontend publicado é `backend/public`. A estrutura alternativa `backend/src` e o frontend React em `painel/src` não são a entrada de `npm start` e não foram convertidos em um projeto novo.

Foram reaproveitados: contas em `assinaturas`, serviços em `servicos_assinatura`, reservas em `agendamentos`, bloqueios, autenticação dos profissionais, autenticação administrativa separada, regras de acesso/assinatura, liberação manual, Mercado Pago, adaptador Evolution, autenticação do webhook e fila de respostas do WhatsApp.

O agendamento anterior considerava intervalos fixos de 30 minutos. A evolução permite duração por serviço e profissionais compatíveis. Os caminhos antigos que criam reservas pelo backend também usam a nova disponibilidade. O editor antigo de serviços agora atualiza/desativa registros, preservando IDs e vínculos. A exclusão de agendamento pelo painel antigo passa a cancelar, preservando histórico.

## O que está disponível

- Marca Studiofy e identidade grafite/azul nas páginas publicadas, login, cadastro, recuperação, checkout e administração. O login abre `/studiofy.html`; configuração de WhatsApp, assinatura e suporte continuam disponíveis no painel anterior, integrado por links.
- Dashboard com dados reais, agenda com confirmação/cancelamento/remarcação/conclusão/falta, clientes derivados das reservas, financeiro e relatórios baseados em atendimentos concluídos.
- Serviços livres: nome, descrição, preço, duração, imagem e status. “Excluir” desativa, sem apagar histórico. Preços de serviços são independentes do preço da assinatura, que não mudou.
- Profissionais e seleção dos serviços que realizam; profissional inicial para quem trabalha sozinho.
- Horários por dia, intervalos de almoço, dias de folga, bloqueio integral ou parcial para todos ou para um profissional.
- Página `/agendar/:slug` com capa padrão ou personalizada, logo, descrição, WhatsApp opcional, serviços, preços, duração, profissionais e horários disponíveis.
- Revisão antes da confirmação; reserva transacional; conflitos parciais de duração também são recusados. O painel atualiza telas de consulta a cada 30 segundos sem sobrescrever formulários abertos.
- Personalização com prévia antes de salvar. Imagens PNG/JPEG/WebP de até 2 MB, resolução máxima de entrada de 16 milhões de pixels, decodificação e reprocessamento com Sharp para WebP. SVG/arquivos inválidos não são aceitos. As imagens ficam no PostgreSQL, evitando perda em filesystem efêmero.
- Dados do estabelecimento são obtidos da sessão autenticada; IDs enviados pelo cliente não escolhem a conta. Relações de profissionais/serviços têm validação de propriedade também no banco. Dados públicos não incluem credenciais, clientes ou reservas identificadas.

## WhatsApp e lembrete de 20 minutos

A Evolution foi mantida. As saudações reconhecidas recebem o link individual; mensagens comuns ficam disponíveis para conversa com o estabelecimento. O chatbot de escolha de serviço/data/horário deixou de ser conectado aos handlers ativos. O bridge local também passa a fornecer o link; seu antigo loop de lembretes de 15 minutos/7 dias não é mais iniciado. O envio automatizado novo usa exclusivamente o adaptador Evolution existente.

`appointment_reminders` guarda agendamento, conta, `due_at`, `status`, `sent_at`, `attempts`, `last_error` e `claimed_at`. Um trigger cria/atualiza o lembrete na mesma transação da reserva. A previsão é calculada no PostgreSQL como **data/hora do atendimento em America/Sao_Paulo menos 20 minutos**.

O worker consulta o banco a cada segundo; não depende de um temporizador longo em memória. Múltiplas instâncias disputam uma reivindicação persistente, e apenas uma envia. Antes do envio, o worker relê os dados reais e bloqueia a linha do agendamento para coordenar cancelamentos/remarcações. O envio HTTP não mantém o bloqueio global da agenda. Cancelamento confirmado antes do envio impede a mensagem; remarcação muda sua previsão. Se o envio já estiver em andamento, cancelar não pode recolher uma mensagem já entregue ao provedor.

Lembretes pendentes sobrevivem a reinícios. Se o servidor voltar depois da previsão, mas antes do atendimento, envia o lembrete atrasado com texto apropriado. Depois do início do atendimento, marca como expirado e não envia.

**Limite de entrega:** previsão exata não significa entrega garantida no segundo exato. Polling, fila, disponibilidade do servidor, conexão WhatsApp e tempo de resposta da Evolution afetam a entrega. Não houve teste com mensagens reais. O adaptador atual não usa uma chave de idempotência com garantia de deduplicação confirmada. Se ocorrer timeout, falha de envio ou interrupção depois de reivindicar uma mensagem, ela fica como **entrega incerta** (reivindicações interrompidas são identificadas após dois minutos). Não há reenvio automático nesse caso, para evitar duplicação; o estabelecimento deve conferir o WhatsApp. Não se promete simultaneamente entrega garantida e exatamente uma mensagem em falhas ambíguas.

A tela Notificações mostra os estados. Sem instância Evolution configurada, o agendamento funciona pelo site; o lembrete aguarda até expirar. O link usa `PUBLIC_APP_URL` ou `RENDER_EXTERNAL_URL`, já existentes. Nenhum `.env` foi alterado. Não foi introduzida outra API. Se futuramente for exigida entrega com garantias maiores, será necessário avaliar um canal com idempotência/consulta de entrega e seus custos antes de trocar o adaptador.

## Migration e dados existentes

Nova migration: `backend/database/migrations/005_studiofy.sql`. Nenhuma migration anterior foi reescrita.

Ela acrescenta campos de personalização/horários às contas, duração/descrição/imagem/status aos serviços, profissionais, relações profissional–serviço, campos de duração/profissional nas reservas, bloqueios por profissional e tabela/índices/triggers de lembretes. O índice de início de reserva passa a considerar o profissional; o trigger também verifica sobreposição de intervalos. Transações serializadas coordenam a criação de reservas, inclusive entre processos.

Contas antigas recebem link `studio-ID`, profissional inicial com o nome do responsável e vínculos com seus serviços. Serviços/reservas antigos recebem duração inicial de 30 minutos, correspondente à regra anterior; o dono deve revisar durações reais antes da publicação. Horários antigos são usados enquanto não houver configuração semanal nova. Reservas confirmadas futuras recebem lembrete de 20 minutos. Contas novas são inicializadas ao abrir a gestão/página ou receber saudação.

Não há remoção de contas, serviços ou reservas na migration. Dados financeiros, credenciais e plano são preservados. Exclusão administrativa explicitamente solicitada na interface mantém seu comportamento anterior e também remove os novos registros dependentes.

Riscos para uma futura publicação: alterações de schema/índices precisam de janela compatível com o volume do banco; dados antigos com datas/horários inválidos podem fazer a migration falhar e reverter a transação. Um backup e ensaio em cópia do banco real continuam necessários antes de autorizar produção. O teste local de upgrade usa dados representativos, não uma cópia dos dados de produção. O código atual executa migrations no startup: não iniciar esta versão apontando para produção antes da autorização.

As sessões existentes continuam em memória, como antes: reiniciar o backend exige novo login. Reservas/lembretes persistem. Relatórios não são conciliação bancária; imagens no banco e listagens completas precisam de avaliação de volume antes de uso em grande escala.

## Arquivos alterados

| Área | Arquivos |
| --- | --- |
| Integração e rotas | `backend/app.js`, `backend/routes.js`, novo `backend/studiofyRoutes.js` |
| Banco | `backend/database/postgres.js`, nova migration `005_studiofy.sql` |
| Regras e lembretes | novos `backend/services/studiofy.js`, `backend/services/reminders.js`, `backend/services/whatsapp/scheduling.js` |
| WhatsApp | `backend/evolutionWebhook.js`, `backend/whatsappWebhook.js`, `backend/botFlow.js`, `backend/wppconnect.js` |
| Telas novas integradas ao projeto | `backend/public/studiofy.html`, `studiofy.js`, `studiofy.css`, `agendar.html`, `agendar.js` |
| Telas existentes | `backend/public/index.html`, `landing.js`, `styles.css`, `barbeiro.html`, `cadastro.html`, `controle-interno.html`, `recuperar-senha.html`, `redefinir-senha.html` |
| Testes | novos `backend/test/studiofy.test.js`, `studiofy-browser.test.js`; atualizados `chatbot.test.js`, `migration.test.js` |

As exclusões que já estavam no Git em `.codex/backups/` foram encontradas antes do trabalho e não foram realizadas nesta reformulação.

## Validação e revisão local

Suíte: `node --test backend/test/*.test.js`, usando PostgreSQL local exclusivo em `127.0.0.1:55441`, com schema aleatório por teste. Pagamentos e Evolution são simulados; credenciais reais não são usadas. Os testes verificam isolamento, CRUD/desativação, uploads, página pública, autenticação, profissionais incompatíveis, concorrência HTTP e SQL, duração, bloqueios, cancelamento/remarcação, estados de lembrete, upgrade e importação, além das regressões administrativas e financeiras existentes.

Teste Chromium de ponta a ponta: login, serviço, personalização/prévia, agendamento público com revisão e confirmação, reflexo no painel, viewport desktop de 1440 px e móvel de 390 px, sem erro JavaScript nem vazamento horizontal da página. Isso não substitui teste em Safari/iPhone e Android físicos. Não foi fornecido arquivo de mockup; o visual segue a descrição do pedido.

Prévia local: `http://127.0.0.1:3017/agendar/studiofy-demo`. Processo de demonstração em `.tmp/studiofy-preview-server.cjs`, com schema separado `studiofy_preview`, dados fictícios e integrações externas desabilitadas. Para revisar a gestão, o login da demonstração está definido apenas nesse arquivo local ignorado pelo Git. A prévia não inicia workers de envio e não lê `.env`.

Capturas: `.tmp/studiofy-preview/dashboard-desktop.png`, `painel-mobile.png`, `agendamento-mobile.png` e `confirmacao-mobile.png`. Log completo: `.tmp/studiofy-all-tests.log`.

Nenhum commit, push, deploy, cobrança real, alteração de segredo ou acesso ao banco de produção foi realizado.

## Retomada e verificação em 18/09/2026

### Adaptação à referência visual enviada

Interface atualizada com marca Studiofy, navegação compacta com ícones, cards de indicadores, gráfico dos últimos sete dias calculado a partir das reservas, próximos atendimentos, lista compacta de serviços e prévia de personalização lado a lado no desktop. A agenda agora oferece calendário semanal, navegação entre semanas e modo de lista com as ações existentes. O calendário abre o formulário de remarcação ao selecionar uma reserva.

Página inicial/login e agendamento público seguem a composição grafite/azul da referência, com fotografia local de salão como capa padrão. Foto ilustrativa obtida de `https://images.unsplash.com/photo-1521590832167-7bcbfaa6381f`, salva em `backend/public/assets/studiofy-salon.jpg`; capas personalizadas continuam prevalecendo. Não foram adicionados botões de login social sem integração nem números fictícios aos indicadores.

Arquivos desta adaptação: `backend/public/studiofy.html`, `studiofy.js`, `studiofy.css`, `index.html`, `agendar.html`, novo `studiofy-landing.css`, foto local e `backend/test/studiofy-browser.test.js`. Nenhuma migration adicional. Suíte completa após a adaptação: **187 aprovados, zero falhas e zero ignorados**, em `.tmp/studiofy-reference-all-tests.log`. O teste de navegador também verifica navegação semanal, alternância calendário/lista e abertura de remarcação. Página inicial conferida em 1440 px e 390 px, sem transbordamento horizontal.

O pedido original foi conferido com a implementação local existente. A suíte completa foi executada novamente no PostgreSQL exclusivo de testes: **187 testes aprovados, zero falhas e zero ignorados**, incluindo Chromium. Log desta execução: `.tmp/studiofy-resume-tests.log`. As capturas em `.tmp/studiofy-preview/` foram atualizadas pelo teste de navegador.

A demonstração local foi reiniciada; a página `/agendar/studiofy-demo` e sua API pública responderam HTTP 200 em `http://127.0.0.1:3017`. A demonstração mantém os dados fictícios existentes, sem iniciar envios ou cobranças. `git diff --check` passou. A validação continua local: entrega real pela Evolution, dispositivos físicos e ensaio com cópia do banco de produção permanecem fora dos testes realizados.
