# Studiofy — diagnóstico e plano incremental

Análise do repositório local em 23/09/2026. Nenhum código de aplicação, migration existente ou dado foi alterado nesta análise.

## Conclusão

O sistema já tem uma base aproveitável de agendamento multissegmento. A evolução deve acontecer no servidor atual, preservando autenticação, pagamentos, webhooks, WhatsApp e os contratos existentes. Não há motivo identificado para reconstruir tudo ou trocar imediatamente para React.

Os maiores trabalhos pendentes são: separar estabelecimento de assinatura na modelagem, completar o isolamento de dados, criar acessos de equipe, disponibilidade individual, CRM persistente, conversas, financeiro e comissões.

## Escopo e limites da verificação

- Foram examinados os pontos de entrada, configuração de publicação, inventário de rotas, schemas/migrations, persistência, autenticação, agendamento, telas atuais, integrações e testes existentes. A base alternativa também foi identificada e comparada com o fluxo ativo.
- As conclusões sobre o banco se referem às migrations e consultas do repositório. Não foi inspecionado o banco de produção nem confirmado quais migrations estão aplicadas nele.
- `TEST_DATABASE_URL` não está definida nesta sessão. Portanto, integração PostgreSQL, concorrência real, migrações e fluxos completos de pagamento/agendamento não foram revalidados em execução nesta análise.
- Testes com provedores simulados não comprovam conexão, entrega de mensagem ou pagamento em produção.
- Há alterações locais anteriores à análise, inclusive cancelamento público, migration `006`, frontend e testes; há também backups antigos marcados como excluídos no Git. Esses arquivos foram preservados. O diagnóstico considera o estado local, que pode diferir do publicado.

### Testes executados nesta análise

Resultado: **61 testes passaram, zero falhas e zero ignorados**, em aproximadamente 32 segundos. Comando executado em `backend`:

```sh
node --test test/evolution-api.test.js test/evolution-429-diagnostics.test.js test/evolution-cooldown.test.js test/evolution-existence.test.js test/evolution-single-connect.test.js test/frontend.test.js test/painel-whatsapp.test.js test/payment-diagnostics.test.js
```

Cobertura desta execução: transporte e erros da Evolution com servidor simulado, proteção de segredos, cooldown/cache/concorrência de conexão, frontend servido pelo servidor alternativo, painel WhatsApp no navegador e diagnóstico de pagamento simulado. Não foi executada a suíte completa dependente de PostgreSQL; os testes existentes de agendamento, cancelamento, isolamento, migrations e reconciliação de pagamentos ainda precisam ser executados em banco exclusivo de testes.

## Arquitetura realmente utilizada

| Camada | Implementação atual |
|---|---|
| Inicialização | `backend/package.json`: `npm start` executa `app.js`; `render.yaml` mantém esse comando |
| HTTP/API | Express em `backend/app.js`, com `routes.js` montado antes das rotas legadas em memória |
| Studiofy | `/api/studiofy`, implementada em `studiofyRoutes.js` e `services/studiofy.js` |
| Frontend servido | HTML/CSS/JavaScript em `backend/public`; painel Studiofy, cadastro, painel antigo e controle interno |
| Página pública | `/agendar/:slug`, com API pública de serviços, profissionais, horários, reserva e cancelamento |
| Persistência | `database.js` → `database/postgres.js`; migrations em `backend/database/migrations` |
| WhatsApp | Evolution API, webhook autenticado, fila persistente; adaptadores locais WPPConnect preservados |
| Pagamento SaaS | Mercado Pago Checkout Pro, reconciliação e webhook com assinatura verificada |
| Processamento periódico | Workers de respostas WhatsApp e lembretes iniciados pelo processo web após o banco ficar pronto |
| Base alternativa | `backend/src` e `painel/src`: APIs/modelos próprios e React; não representam o produto iniciado por `npm start` |

`backend/AUDIT.md` é histórico e recomenda uma direção diferente da atual. O README e o comando de inicialização deixam claro qual fluxo está ativo. Não misturar os dois conjuntos de migrations ou trocar o servidor para aproveitar funcionalidades isoladas da base alternativa.

## Comparação com os requisitos

“Existente” abaixo significa identificado no código local; não equivale a homologado em produção.

| Área | O que existe | O que falta ou precisa evoluir |
|---|---|---|
| 1. Cadastro | Nome, responsável, contato, e-mail, senha, serviços, horários e assinatura | Tipos de negócio configuráveis; endereço completo/UF, Instagram e identidade no onboarding. Há campos legados de rua/cidade/referência, mas não um cadastro completo integrado |
| 2. Dashboard | Agendamentos confirmados de hoje, clientes, total concluído, faturamento acumulado, próximos horários e gráfico de sete dias | Receitas por dia/semana/mês, cancelamentos, rankings e horários movimentados; agregação no backend |
| 3. Agenda | Calendário semanal, lista, criação, remarcação, profissional e alteração de status | Visualizações diária/mensal e filtro por profissional; observações e detalhes completos; status agendado e em atendimento |
| 4. Profissionais | Nome, ativo/inativo e serviços habilitados | Foto, telefone, especialidade, jornadas, intervalos, férias/folgas e comissão |
| 5. Serviços | Nome, descrição, preço, duração, foto, ativo/inativo e vínculo com profissionais | Categorias configuráveis e organização por segmento sem regras fixas |
| 6. Página pública | Slug individual, logo, capa, cor, descrição, contato, serviços, profissionais e horários calculados | Endereço/redes sociais, seleção simplificada quando houver um profissional e horários individuais |
| 7. Confirmação/cancelamento | Resumo, link privado aleatório, hash persistido, confirmação explícita e antecedência configurável | Homologar a alteração local e garantir a mesma política nos caminhos legados de cancelamento |
| 8. WhatsApp | Saudação com nome e link do estabelecimento no webhook Evolution; conexão e diagnósticos existentes | Modelo de mensagem editável por empresa; revisar todos os adaptadores e textos legados |
| 9. Lembretes | Lembrete persistente de 20 minutos, estados, tentativas, horário de envio e tratamento de entrega incerta | Múltiplas antecedências e mensagens personalizadas. A tabela permite hoje apenas um lembrete por agendamento |
| 10. Clientes | Lista montada a partir do telefone nos agendamentos, com número de atendimentos concluídos | CRM próprio por empresa, edição, e-mail, nascimento, notas, histórico, gastos e próximos horários |
| 11. Conversas | Sessões e fila de respostas automáticas por empresa | Caixa de entrada, histórico completo recebido/enviado, não lidas, resposta manual e vínculo com cliente. Mensagens comuns são ignoradas pelo webhook atual |
| 12. Financeiro | Soma mensal dos valores de atendimentos concluídos | Movimentações persistentes, receitas/despesas, meios de pagamento, lucro e geração idempotente por atendimento |
| 13. Comissões | Não identificadas no fluxo ativo | Regras percentual/fixa/sem comissão, valor histórico por atendimento e relatório por período |
| 14. Disponibilidade | Horários semanais do estabelecimento, intervalos, duração, conflitos e bloqueios por profissional ou gerais | Interseção com jornadas individuais, férias, feriados e bloqueios por período |
| 15. Relatórios | Resumo de serviços concluídos e valores | Filtros e relatórios de clientes, profissionais, cancelamentos, faltas, receita e comissões |
| 16. Personalização | Nome, descrição, telefone, logo, capa, cor, slug e prévia | Integrar endereço, Instagram e demais informações públicas |
| 17–18. Assinatura/superadmin | Pagamentos, acesso manual, bloqueio, vencimentos, listagem e exclusão controlada | Catálogo de planos, métricas gerais/agendamentos por empresa e central de erros. Cobrança atual é renovada por checkout, sem débito recorrente automático |
| 19. Menu | Dashboard, agendamentos, clientes, serviços, profissionais, financeiro, horários, página, notificações, relatórios, configurações e assinatura | Conversas, navegação integrada de WhatsApp e menu conforme permissões; algumas opções remetem ao painel antigo |
| 20. Permissões | Login do estabelecimento e login administrativo separados | Usuários proprietários, gerentes/recepção e profissionais com autorização no backend. A base alternativa tem papéis, mas eles não implementam isso no fluxo ativo |
| 21. Celular | CSS responsivo, menu móvel, calendário com rolagem interna e testes de navegador existentes | Homologação completa dos novos módulos, acessibilidade e desempenho com volume real |
| 22. Segurança | Hash de senha com salt/scrypt, tokens, queries parametrizadas, autorização por assinatura, webhook autenticado e limite nas rotas públicas Studiofy | Limites no login/cadastro/recuperação, política de senha (cadastro aceita quatro caracteres), sessão persistente, revisão de proxy, permissões e erros expostos |
| 23–24. Banco/preservação | PostgreSQL, migrations transacionais com checksum, testes e compatibilidade legada | Confirmar estado implantado, backup restaurável, auditoria de dados históricos e ampliação gradual das relações por empresa |

## Pontos técnicos que determinam a ordem de implementação

1. **Estabelecimento e cobrança estão acoplados.** `assinaturas` armazena empresa, credenciais, personalização, WhatsApp e cobrança. `assinatura_id` funciona como identificador de empresa. Criar uma entidade `establishments` com mapeamento explícito para a conta legada; manter os identificadores e referências de pagamento durante a transição. Não renomear todas as tabelas/rotas de uma vez.
2. **O isolamento já existe em partes, mas não está completo.** Serviços/profissionais têm relações compostas por empresa; o trigger de agendamentos valida profissional e serviço. Entretanto, `clientes` é global e agendamentos/bloqueios legados aceitam vínculo de empresa nulo. Há FKs históricas `NOT VALID`. Auditar órfãos e pertencimento antes de impor novas restrições, sem apagar registros para fazer a migration passar.
3. **A disponibilidade individual ainda não existe.** `times()` consulta os horários da empresa, habilitação do profissional, agendamentos e bloqueios. A tabela de profissionais não contém jornada. Acrescentar uma jornada própria usando o horário da empresa como padrão para preservar contas existentes.
4. **Novos status afetam regras críticas.** Disponibilidade, índice de unicidade, trigger e lembretes usam `confirmado`. Definir status que ocupam horário, transições e efeito sobre receita/cancelamento antes de adicionar `agendado` e `em_atendimento`. Um botão novo isolado poderia liberar um horário ocupado.
5. **As transações serializadas usam um lock comum ao schema.** Isso ajuda a preservar a regra atual, mas faz empresas diferentes disputarem o mesmo lock. Só reduzir sua abrangência após testes concorrentes cobrindo todos os escritores, inclusive os legados.
6. **Lembretes têm uma proteção útil a preservar.** Há claim persistente e estado `uncertain`: entrega incerta não é reenviada automaticamente. Múltiplas antecedências exigem nova chave de unicidade e regras para remarcar/cancelar, sem recriar um envio já realizado.
7. **Fila de resposta automática não é histórico de conversas.** `whatsapp_messages` guarda respostas às saudações; não armazena toda a conversa. A fila de respostas faz retry em erro, diferente do worker de lembretes; um timeout após entrega precisa ser considerado para evitar duplicidade.
8. **Sessões de login estão em memória.** Reinícios invalidam sessões e múltiplas instâncias não compartilham autenticação. O armazenamento `sessoes` encontrado é do bot, não uma solução persistente para login de equipe.
9. **O painel carrega todo o histórico.** `/painel` entrega todos os agendamentos e o navegador calcula totais. Criar consultas paginadas e agregações por período para manter o celular rápido conforme a base crescer.
10. **Lembretes dependem do processo web estar executando.** Validar a operação contínua da hospedagem e monitorar atraso da fila; um cronômetro em memória não garante execução quando o processo está parado. Os registros pendentes são persistentes, mas o worker atual expira lembretes vencidos.

Evidências principais: `backend/services/studiofy.js`, `backend/studiofyRoutes.js`, migrations `001`, `003`, `005` e `006`, `backend/services/reminders.js`, `backend/services/publicBookings.js`, `backend/evolutionWebhook.js`, `backend/routes.js` e `backend/public/studiofy.js`.

## Plano por etapas e critérios de aceite

Cada etapa deve ser pequena e revisável, com migrations novas, testes específicos e regressão dos fluxos preservados. Não iniciar a etapa seguinte enquanto houver regressão relevante.

| Etapa | Entrega | Validação necessária |
|---|---|---|
| 0. Base de segurança operacional | Inventariar alterações locais, registrar versão implantada, preparar PostgreSQL exclusivo de testes, backup do banco e arquivos necessários e ensaio de restauração | Restaurar cópia isolada; comparar contagens/relações; rodar a suíte existente, incluindo migration, Studiofy, cancelamento público, pagamentos, admin e navegador |
| 1. Identidade multissegmento | `establishments`, tipos de negócio, endereço/UF/Instagram, onboarding e personalização; camada de compatibilidade com `assinaturas` | Conta antiga mantém login, slug, serviços, agendamentos e checkout; conta nova de diferentes segmentos percorre o cadastro; migração preserva IDs legados |
| 2. Isolamento e acessos | Usuários e vínculos com empresa, proprietário/gerente/profissional, sessões persistentes, políticas de rota e menu | Conta A não consulta/altera B mesmo trocando IDs; profissional só acessa operações/horários autorizados; recepção não altera cobrança ou permissões |
| 3. Catálogo e disponibilidade | Categorias, cadastro completo de profissionais, jornadas, intervalos, folgas/férias e bloqueios por período | Horários respeitam empresa + profissional + duração + bloqueios; tentativas simultâneas não duplicam reserva; padrões preservam agenda antiga |
| 4. Agenda e reserva | Dia/semana/mês/profissional, observações, seis status, transições, página pública completa e confirmação/cancelamento consistentes | Status ocupantes impedem conflito em todos os caminhos; política de cancelamento e lembretes continua correta; fluxo móvel completo |
| 5. CRM | Clientes próprios por estabelecimento, perfil editável, vínculo dos agendamentos, histórico e indicadores | Telefone igual em empresas diferentes não compartilha dados; backfill não mistura pessoas; histórico e totais conferem com atendimentos |
| 6. WhatsApp e lembretes | Saudação editável e múltiplas antecedências, preservando 20 minutos e contratos de integração | Webhook repetido, reinício, workers simultâneos, timeout, remarcação e cancelamento não criam envios indevidos; entrega incerta é distinguida de falha confirmada |
| 7. Conversas | Persistência recebida/enviada, lista, não lidas, resposta manual e contexto do cliente | Isolamento de empresa, deduplicação por mensagem do provedor, estado real de envio e convivência entre automação e atendimento humano |
| 8. Financeiro e comissões | Movimentações, meios de pagamento, despesas, estornos/ajustes e regras de comissão | Concluir duas vezes gera uma receita; alteração posterior de preço/comissão não muda o histórico; cancelamento/reabertura tem regra explícita e rastreável |
| 9. Dashboard e relatórios | Métricas e filtros completos, consultas no backend, paginação e gráficos | Totais reconciliam com movimentos e status; limites do período/fuso corretos; bom desempenho com volume representativo |
| 10. Superadmin e acabamento | Planos, métricas globais, erros de integração, navegação e revisão móvel/acessibilidade | Mudanças de plano não alteram cobranças antigas indevidamente; empresa não acessa API de superadmin; regressão ponta a ponta |

## Estratégia de banco e compatibilidade

- Usar nomes genéricos para entidades novas: `establishments`, `users`, `establishment_users`, `business_types`, `service_categories`, `professional_schedules`, `customers`, `conversations`, `conversation_messages`, `financial_transactions` e regras de comissão. Os nomes finais e os DDLs devem ser definidos na etapa correspondente.
- Reaproveitar serviços, profissionais, agendamentos e bloqueios existentes com adaptações graduais; não manter dois cadastros concorrentes sem fonte de verdade definida.
- Evoluir por adição: criar estrutura, preencher vínculos em lotes verificáveis, comparar dados, passar leituras/escritas para a nova estrutura e só depois descontinuar compatibilidade.
- Toda entidade de empresa deve possuir vínculo validável com o estabelecimento. Relações entre entidades também devem validar o mesmo estabelecimento, não apenas a existência do ID relacionado.
- Não deduzir propriedade de clientes globais pelo telefone sozinho. Usar os agendamentos vinculados a cada empresa; casos ambíguos exigem tratamento explícito.
- Não editar migrations já aplicadas: o executor rejeita alterações de checksum. Criar novas migrations depois de confirmar quais estão efetivamente implantadas, especialmente a `006` local.
- A transação de migration é uma proteção contra falha de aplicação, não um backup. Antes de migrar dados, produzir cópia e provar restauração em ambiente separado.
- Planejar reversão de código compatível com as colunas novas; evitar rollback destrutivo que apague reservas, mensagens ou movimentações criadas após a publicação.
- Separar receitas do estabelecimento de pagamentos da assinatura Studiofy. Preservar referência externa, autenticação dos webhooks e idempotência de crédito do Mercado Pago.

## Próxima entrega recomendada

Começar pela etapa 0 e, com a regressão validada, implementar somente a etapa 1. A primeira mudança funcional deve entregar cadastro multissegmento e identidade do estabelecimento com compatibilidade legada, sem juntar CRM, financeiro e conversas no mesmo lote.

Esta análise não realizou backup de produção, migration, deploy, cobrança ou envio real de WhatsApp.
