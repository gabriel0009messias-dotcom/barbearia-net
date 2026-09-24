# Studiofy — etapa 1: base multissegmento

Implementação incremental sobre Express/PostgreSQL e `backend/public`, sem ativar a base React alternativa. Esta entrega não implementa CRM, conversas, financeiro, comissões, relatórios avançados ou um novo superadmin.

## Entregas

- Cadastro com nome do estabelecimento, responsável, tipo de negócio, contatos, cidade/UF, endereço opcional, Instagram, logo e capa opcionais.
- Primeiro serviço informado pelo usuário, com preço, duração e categoria. Foi removido o serviço “Corte” inserido automaticamente pelo formulário. Serviços adicionais, descrição, imagem, status e profissionais habilitados continuam no painel existente.
- Catálogo de 11 tipos de negócio carregado do PostgreSQL, sem regras de agendamento ou serviços condicionadas ao tipo. Autônomos podem usar qualquer segmento ou “Outro”.
- Personalização permite editar os novos dados. A página pública mostra endereço, cidade/UF, Instagram e categorias, além da identidade visual existente.
- Categoria é texto livre pertencente ao próprio serviço da empresa, não um catálogo compartilhado de dados de clientes.
- Profissionais e vínculos com vários serviços foram preservados. Nenhum tipo exige profissão específica.

## Arquivos desta etapa

| Arquivo | Mudança |
|---|---|
| `backend/database/migrations/007_multisegment.sql` | Nova migration aditiva |
| `backend/services/establishment.js` | Validação e persistência do perfil, projeção de campos públicos |
| `backend/routes.js` | Catálogo público, cadastro genérico compatível e transação de conta/serviços/perfil/imagens |
| `backend/services/studiofy.js` | Validação da categoria livre |
| `backend/studiofyRoutes.js` | Perfil na API pública/painel, edição e persistência de categoria |
| `backend/public/cadastro.html`, `cadastro.js` | Campos novos, leitura de imagens e primeiro serviço livre |
| `backend/public/studiofy.js`, `studiofy.html` | Editor de identidade/categoria e versão do script |
| `backend/public/agendar.js`, `agendar.html` | Localização, Instagram, categoria e versão do script |
| `backend/test/cadastro-browser.test.js` | Cadastro com novos campos e verificação do payload |
| `backend/test/migration.test.js` | Preservação de registros após migration 007 e inventário atualizado |
| `backend/test/multisegment.test.js` | Validação dos segmentos e teste integrado PostgreSQL |
| `backend/test/multisegment-browser.test.js` | Página móvel dos quatro segmentos e editores de perfil/serviço |
| `STUDIOFY-ETAPA1.md` | Entrega, compatibilidade, testes e operação |

As mudanças de cancelamento público, migration 006 e outros arquivos já modificados antes desta etapa foram mantidas. Elas não foram recriadas nem removidas. O diagnóstico permanece preparado no índice do Git pela tentativa anterior de publicação; esta etapa não fez commit, push ou deploy.

## Banco e migration

`007_multisegment.sql` cria `business_types(code, name, active, sort_order)` com os tipos iniciais: Barbearia, Salão de beleza, Unhas/Manicure, Sobrancelhas, Estética, Massagem, Maquiagem, Depilação, Lash designer, Spa e Outro.

Acrescenta:

- `assinaturas.business_type_code`: referência ao catálogo, obrigatório, padrão `other`.
- `assinaturas.state_code`: padrão vazio para preservar cadastros antigos.
- `assinaturas.instagram_handle`: padrão vazio.
- `servicos_assinatura.categoria`: texto de até 100 caracteres, padrão vazio.

Cidade e endereço reutilizam `localizacao_cidade` e `localizacao_rua`; não há cópia concorrente dessas informações. Nenhuma tabela ou linha é apagada. Preços, duração existente, pagamento, senha, slug, profissional e agendamento existentes não são reescritos pela migration.

O catálogo é configurável por SQL/migrations administrativas. Não foi criado painel de gestão de tipos nesta etapa. Não excluir códigos em uso; novos tipos não exigem alteração do frontend ou regras de negócio. Manter `other` ativo como padrão de compatibilidade.

## Compatibilidade e dívida técnica mapeada

| Termo/contrato legado | Tratamento |
|---|---|
| `assinaturas`, `assinatura_id` | Continuam representando a conta/empresa existente. Separar estabelecimento de cobrança fica para uma migration futura; não foi criada uma segunda fonte de verdade |
| `barbearia_nome` | Coluna preservada; representa o nome de qualquer estabelecimento |
| `barbeariaNome` no cadastro | Continua aceito por clientes antigos; o formulário novo envia `establishmentName` |
| `/api/barbeiro/*`, `x-barbeiro-token`, `/barbeiro.html` | Mantidos para não quebrar autenticação, WhatsApp, recuperação e assinatura |
| `barbearia_auth_token`, `barbearia_pending_signup`, IDs de formulário antigos | Mantidos para preservar sessões, navegação e clientes existentes |
| Variáveis `salon`, `barberSessions`, IDs como `salonName` | Identificadores internos preservados, sem impor profissão ao usuário |
| Código de tipo `barbershop` | Representa apenas o segmento Barbearia; não é nome de entidade genérica nem regra de serviço |
| `backend/src`, `painel/src`, rotas demo de `app.js`, documentos históricos | Identificados como código alternativo/legado. Não recebem substituição automática de termos nem são promovidos ao fluxo ativo |
| Textos de WhatsApp ativos | Evolution e adaptador local já usam o nome/link da empresa; o lembrete usa serviço e profissional. Não foi necessário alterar lógica ou mensagens de conexão |

Clientes antigos podem continuar enviando somente nome/preço de serviço no cadastro; duração assume 30 minutos. Omitir categoria na edição preserva a categoria atual. Omitir campos novos na edição de página preserva o perfil atual. O cadastro pela chave nova exige tipo, cidade e UF, enquanto o contrato legado continua aceitando ausência desses campos.

Categorias e perfis são gravados com o identificador da conta autenticada. Associações profissional/serviço e proteções existentes contra usar IDs de outra empresa continuam aplicadas. O catálogo de segmentos é global e não contém dados particulares de empresas.

## Backup, implantação e reversão

- Backup local dos arquivos afetados antes das edições: `.tmp/etapa1-before.zip`. Ele inclui o estado local anterior, inclusive mudanças ainda não commitadas dos arquivos selecionados. Não é um backup do banco e não deve ser publicado.
- Não foi conectado nem alterado banco de produção nesta execução. Nenhuma migration foi aplicada por esta etapa.
- Antes da publicação: obter backup restaurável do PostgreSQL real e testar em ambiente isolado. Confirmar quais migrations estão aplicadas; a 007 pressupõe 001–006, inclusive o cancelamento local anterior.
- Executar `npm.cmd run migrate` em `backend` no ambiente correto ou permitir o executor existente na inicialização. Não editar migrations antigas: o checksum impede isso. O executor usa transação e rollback em erro.
- Reversão preferida: voltar o código para a versão anterior e manter as estruturas aditivas, preservando os novos dados. Não executar `DROP` para reverter uma publicação com novos cadastros. Recuperação por backup exige avaliar as escritas posteriores para não perder reservas.

## Testes executados

Comando: `npm.cmd test`, em `backend`, executando todos os arquivos `test/*.test.js` existentes e os novos. Resultado final: **117 testes contabilizados, 102 passaram, 14 falharam na preparação por ausência de `TEST_DATABASE_URL`, 1 foi ignorado explicitamente pelo mesmo motivo**. Nenhum teste foi cancelado. A suíte completa retorna código 1; não está homologada integralmente. Os 61 testes da análise anterior continuam passando.

Passaram: cadastro/checkout com API simulada, quatro segmentos, validações do perfil/categoria, tipos configuráveis, página pública móvel, editores de identidade/serviço, painéis administrativos com APIs simuladas, conexão/erros/limites da Evolution, frontend, configurações de banco e diagnósticos de pagamento. Também passaram as verificações sintáticas dos sete arquivos JavaScript de aplicação alterados e `git diff --check`.

Pendentes por PostgreSQL não configurado: liberação manual, exclusão/listagem administrativa integrada, webhook WhatsApp, upgrade/importação de banco, pagamento Mercado Pago integrado, migration de preço, cancelamento público, cadastro existente, inicialização do backend ativo, Studiofy integrado/no navegador e rotas WhatsApp integradas. O novo teste PostgreSQL de quatro segmentos inclui isolamento por empresa, reserva concorrente, sobreposição parcial, cancelamento, bloqueio de lembrete cancelado e envio único do lembrete de 20 minutos; está escrito, mas não foi executado.

A execução final está registrada em `.tmp/etapa1-tests.log`. Não foi inventada `TEST_DATABASE_URL`, reaproveitado banco de produção ou enviado pagamento/mensagem real. Para concluir a homologação, configurar uma URL verdadeira de PostgreSQL exclusivo de testes e executar novamente `npm.cmd test`.

## Como testar manualmente

1. Em homologação, com migrations aplicadas, abrir `/cadastro.html`. Criar contas distintas de Barbearia, Unhas/Manicure, Sobrancelhas e Massagem; informar cidade/UF, Instagram e imagens. Cadastrar respectivamente Corte, Manicure, Design e Massagem com preços/durações diferentes.
2. Confirmar que o cadastro chega ao checkout existente. Usar o ambiente de teste do provedor ou liberar a conta pelo procedimento administrativo existente; não simular confirmação de pagamento no banco de produção.
3. Entrar em `/studiofy.html`. Em “Minha página”, conferir os dados, editar endereço/Instagram/tipo e salvar. Abrir o link público e conferir nome, imagens, endereço e link do Instagram.
4. Em “Meus serviços”, editar categoria, descrição, duração, imagem e status. Em “Profissionais”, criar pessoas diferentes e associar serviços. Confirmar que uma empresa não vê serviços/profissionais de outra.
5. Agendar no celular em `/agendar/{slug}`. Conferir serviço, profissional, horário e preço; tentar reservar horário sobreposto em outra aba. Apenas uma reserva conflitante deve ser aceita.
6. Usar o link privado da reserva para cancelar respeitando a antecedência configurada. Confirmar liberação do horário e cancelamento do lembrete pendente.
7. Em instância WhatsApp de homologação, enviar “Oi” e verificar nome/link da empresa; conferir o lembrete de 20 minutos de uma reserva válida. Não reconectar/desconectar uma instância de produção para esse teste.
8. Conferir que conta antiga mantém acesso, serviços, slug, histórico, assinatura e renovação Mercado Pago. Editar sua página sem preencher campos novos deve continuar possível.

## Preservação e limites

Foram preservados os contratos e a lógica existente de agendamento, cancelamento seguro, WhatsApp/Evolution, lembrete de 20 minutos, Mercado Pago e assinatura. A alteração do cadastro mantém o mesmo fluxo de cobrança. Isso não equivale a uma confirmação de funcionamento em produção: os testes integrados PostgreSQL e a homologação real seguem necessários.

Riscos remanescentes: alterações anteriores ainda não publicadas, migration 006 local, ausência de banco exclusivo de testes nesta sessão e acoplamento legado entre empresa e assinatura. O formulário novo torna cidade/UF e primeiro serviço obrigatórios; o cliente antigo da API permanece compatível. O catálogo é administrado pelo banco, sem nova interface superadmin.
