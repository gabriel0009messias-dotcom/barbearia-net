# Backend - Barbearia

API em Node.js para integração com WhatsApp, controle de agendamentos, faturamento e bloqueio de horários.

## Regra financeira do Studiofy

`services/finance.js` é a fonte compartilhada por Dashboard, Financeiro, Relatórios
e pela rota legada efetiva `/api/faturamento` em `routes.js`. Os consumidores do
painel usam `financeiro` do backend; não devem recalcular receita no navegador.
As consultas recebem exclusivamente o `assinatura_id` da sessão autenticada.

Receita exige status `concluido`, data civil real `YYYY-MM-DD`, hora real `HH:mm`
e início do atendimento já alcançado em `America/Sao_Paulo`. A validação temporal
reutiliza a Agenda sem mudar suas regras. Confirmado/agendado, pendente, cancelado,
falta e atendimento futuro não entram. A semana começa segunda-feira; dia, mês e
ano são civis em São Paulo, sempre limitados aos atendimentos não futuros.

O preço salvo em `agendamentos.preco` é a única fonte monetária. Não há fallback
para o catálogo atual. Preços NULL/ausentes, negativos, NaN, infinitos, formatos
não decimais e valores com fração de centavo são excluídos de **todos** os totais,
contagens, rankings e histórico financeiro. Datas e horas inválidas também são
excluídas. Preço zero é válido. Decimais com zeros finais, como `1.0100`, equivalem
a `1.01`; `1.005` e `2.675` são inválidos e não são arredondados. Os dígitos são
convertidos em centavos inteiros, sem multiplicação/arredondamento de float.
Preços além de `Number.MAX_SAFE_INTEGER` centavos são excluídos; se a soma dos
preços válidos exceder esse limite, a resposta falha com mensagem genérica segura
em vez de publicar valor impreciso. O cadastro atual mantém sua validação.

Serviço com nome NULL, vazio ou não textual aparece apenas no resumo como
“Serviço não identificado”. Nenhum registro histórico é atualizado ou saneado
automaticamente por essas regras de leitura.

O legado mantém `{ "total": number }` em reais e autenticação existente, ignora
IDs de estabelecimento enviados pelo navegador e envia `Cache-Control: no-store`,
inclusive nos erros. Falhas internas retornam mensagem genérica sem detalhes SQL.

| `periodo` | Comportamento |
| --- | --- |
| `dia` / `hoje` | Dia atual em São Paulo |
| `semana` | Segunda-feira até o momento atual |
| `mes` | Mês atual, ou `mes=YYYY-MM` solicitado |
| `mes_customizado` | Exige `mes=YYYY-MM` |
| `ano` | Ano atual; preserva consumidores legados |
| `total` / `historico` | Histórico financeiro válido |
| Ausente | Total histórico, preservando o comportamento anterior da rota efetiva |

Períodos desconhecidos, parâmetros repetidos/não textuais, mês fora de `01..12`,
ano `0000`, mês fora do formato e uso de `mes` em período não mensal retornam 400.
Mês válido sem receita retorna `{ "total": 0 }`.

## Cadastro e integridade das reservas públicas

As respostas de cadastro, login, consulta e configuração da assinatura usam uma
allowlist explícita (`services/subscriptionView.js`). Hash/salt de senha, bridge
token, credenciais, payloads privados de provedores e campos novos não aprovados
nunca fazem parte desse DTO. Campos de apresentação aceitam somente escalares ou
datas válidas. As capacidades emitidas intencionalmente pelos protocolos de login,
cancelamento de reserva e integração autenticada continuam nos seus endpoints
específicos; não são copiadas do registro da conta para outras respostas.

Novos cadastros exigem senha textual de 8 a 128 caracteres, com pelo menos oito
caracteres sem contar espaços nas extremidades, sem caracteres de controle. A
senha é armazenada pelo mecanismo scrypt existente, sem trim ou transformação.
Senhas de contas existentes não são invalidadas. A recuperação de senha permanece
com suas regras finalizadas, sem outro endpoint de troca de senha.

E-mail é armazenado sem espaços externos e em minúsculas. Telefones brasileiros
do cadastro são armazenados em dígitos com DDD, sem o DDI 55; contatos equivalentes
com DDI ou máscara são reconhecidos no login e na duplicidade. Nomes e localização
são aparados, UF é maiúscula e Instagram conserva a validação de usuário sem `@`.
A busca também reconhece representações antigas sem reescrever registros. Se mais
de uma conta antiga corresponder à identidade canônica, o login retorna conflito
e solicita suporte; não escolhe uma conta arbitrariamente nem une históricos.
Duplicidade é revalidada dentro da transação de cadastro. A regra existente para
nomes de estabelecimentos homônimos foi mantida, agora consistente sob concorrência.

Todos os escritores ativos de preço de serviços, incluindo primeiro serviço,
criação/edição no Studiofy e configuração legada da assinatura, usam
`services/signupInput.js`. São aceitos números finitos ou strings decimais simples,
não negativos, de zero a R$ 100.000,00, com até duas casas. Vírgula, notação
exponencial textual, valores nulos, booleanos e frações de centavo são recusados;
não há arredondamento silencioso. Centavos são validados pela política financeira
central. Reservas novas também recusam preço inválido ainda existente no catálogo,
sem corrigir automaticamente catálogo ou histórico. Remarcação do mesmo serviço
continua preservando preço e duração históricos.

Horários iniciais e configuração legada exigem HH:MM, horas 00–23 e minutos 00–59,
abertura anterior ao fechamento e almoço ordenado dentro do expediente. Dias
devem estar entre 0 e 6; lista vazia representa estabelecimento fechado. A grade
semanal mantém intervalos ordenados, sem sobreposição, com até quatro por dia.
Toda solicitação de configuração é validada antes de salvar; configuração e
catálogo legado são gravados atomicamente.

Confirmação reconsulta serviço ativo, profissional e vínculo, expediente,
bloqueios e conflitos dentro da transação de reserva. Os dados de serviço,
profissional/vínculo e estabelecimento usados na validação são protegidos por
locks de leitura e reutilizados na gravação. Escritores HTTP de disponibilidade
usam a mesma serialização de transações; UPDATE/DELETE diretos das linhas também
respeitam os locks. Se uma edição de duração vencer antes da confirmação, a
disponibilidade usa a duração nova; se a reserva vencer, a edição espera e o
snapshot da reserva permanece igual ao validado. Terminar exatamente no fechamento
continua permitido; ultrapassá-lo gera conflito, sem reserva parcial. A checagem
de horário passado é repetida antes do INSERT/UPDATE, em America/Sao_Paulo.

As proteções existentes de conflito no banco, estados finais, tokens de
cancelamento, identidade, snapshots e faturamento não foram substituídas.
Não há saneamento automático de registros antigos. Testes
permanentes adicionais: `test/signup-input.test.js` e
`test/signup-public-integration.test.js`, além da suíte completa existente.


## Requisições públicas: confirmação recuperável e limites

A página pública gera uma chave de 256 bits com `crypto.getRandomValues` e salva
cada tentativa separadamente no armazenamento local **antes** do POST. A chave é
uma capacidade privada: não compartilhar, não colocar em URL/query/log. O POST
`/api/studiofy/public/:slug/agendamentos` recebe `Idempotency-Key` hexadecimal de
64 caracteres. Na transação existente, um recibo vincula SHA-256 da chave,
estabelecimento, digest dos dados canônicos e agendamento. A mesma chave/dados
retorna a mesma reserva/capacidade; dados diferentes retornam 409. O token privado
é derivado com separação de domínio da chave aleatória e do estabelecimento; só
seu digest permanece em `public_booking_access`. Não existem tokens/chaves em
claro no banco. Sem a chave, clientes legados conservam a proteção 201/409 por
conflito; a garantia de recuperação exige a chave do protocolo novo.

Se a resposta desaparecer depois do commit, `Recuperar confirmação` reenvia
manualmente a chave e os dados originais. Primeiro consulta o recibo no POST
`/api/studiofy/public/reservas/recuperar`, sem criar reserva. Essa consulta exige
a chave e o digest dos dados originais; o estabelecimento é obtido do recibo,
nunca da identidade enviada pelo navegador. Continua funcionando se a página
for bloqueada ou mudar de slug, com a mesma autoridade do link privado. Se já
existe recibo, não executa outro INSERT. Apenas resposta explícita de recibo
inexistente permite reenviar o POST de criação com a mesma chave; indisponibilidade
ou link revogado não permitem esse fallback. Caso a tentativa nunca tenha sido gravada, usa a validação definitiva da
transação para confirmá-la uma vez. Recibos não expiram enquanto existir a reserva;
retry de reserva cancelada/concluída devolve seu estado atual, sem reativação.
Troca de identidade que revogou o link privado continua revogada: recuperação não
reemite credencial. Não existe busca privada por nome/telefone/ID previsível.

A página usa timeout de 10 segundos para consultas e 15 para mutações, inclusive
leitura do corpo da resposta. Consultas têm até duas tentativas, com pausa de
250 ms, somente para falha transitória (rede, timeout, 502/503/504). 429 não dispara
retry automático. Criação e cancelamento não têm retry automático. Criação de
resultado incerto informa a incerteza e mantém o caminho de recuperação; não
apresenta falha definitiva. Se armazenamento local estiver indisponível, criação
não é enviada. Tentativas de abas diferentes usam registros separados. Após
recuperação, o link é guardado na lista já existente e a tentativa é removida.
Apagar os dados do navegador antes da recuperação elimina essa capacidade;
guarde o link privado quando disponível.

Envio tem guarda de operação em andamento, além de botão desabilitado. Navegação
incrementa versão e aborta consultas; respostas antigas são descartadas mesmo se
o transporte ignorar abort. Confirmação atrasada guarda o acesso recebido, mas
não sobrescreve a nova tela. Disponibilidade tem sequência própria por data e
profissional; mudar serviço também invalida a consulta anterior.

Limites persistem em PostgreSQL e funcionam entre processos/restarts. A migration
012 apenas cria recibos e contadores: não reescreve dados anteriores. Janelas fixas
podem permitir o dobro do limite junto à fronteira de duas janelas.

| Operação | Limite coletivo | Janela | Escopo |
| --- | ---: | --- | --- |
| POST /api/publico/assinaturas | 600 | 15 min | Toda a operação de cadastro |
| POST /api/studiofy/public/:slug/agendamentos | 300 | 15 min | Estabelecimento validado |
| Mesmo POST, proteção global | 3000 | 15 min | Toda a operação de criação |
| GET catálogo e horários públicos | 1200 | 1 min | Estabelecimento validado, compartilhado |
| Mesmos GETs, proteção global | 12000 | 1 min | Toda a operação de navegação |
| POST /api/studiofy/public/reservas/consultar | 240 + 12000 | 5 min | Reserva validada + toda a operação |
| POST /api/studiofy/public/reservas/recuperar | 60 + 3000 | 15 min | Reserva validada + toda a operação |
| POST /api/studiofy/public/reservas/cancelar | 30 + 3000 | 15 min | Reserva validada + toda a operação |

Cadastro permite até quarenta tentativas por minuto em média na janela coletiva,
sem usar identidade pessoal nem confundir quota com regras de duplicidade. Criação
permite até vinte tentativas por minuto por estabelecimento em média; navegação
permite vinte consultas por segundo, compartilhando catálogo/horários. Tetos globais
são dez vezes os tetos de estabelecimento, para conter abuso entre estabelecimentos.
São limites iniciais de proteção contra abuso grosseiro, não uma garantia de capacidade
do servidor. Orçamentos coletivos podem ser esgotados por um agressor; revisar quotas
com métricas agregadas de volume e 429 sem identificar visitantes.

Tetos globais são consumidos antes de consultar estabelecimento, recibo ou capacidade.
Só o estabelecimento localizado e autorizado pelo servidor ganha orçamento específico,
identificado pelo ID canônico, nunca pelo slug fornecido como identidade. Só depois de
validar o token existente da reserva são usados IDs internos de conta/reserva para o
orçamento privado. Recuperação exige recibo e capacidade ainda válida; não reemite
credenciais revogadas. Tokens/chaves aleatórios ou inválidos não criam orçamentos
individuais; permanecem no teto global. Chave de idempotência preserva sua função
transacional e não fornece quota extra. Não há orçamento por nome, CPF, telefone,
email, User-Agent, cookie de rastreamento ou fingerprint.

Excesso responde 429 JSON seguro e `Retry-After`; falha do store responde
503/Retry-After 5, sem fail-open. Contadores usam digests de versão/operação/contexto
validado; não armazenam IP, dados pessoais, chave de idempotência ou token em claro.
Registros vencidos são limpos em lotes limitados. O namespace de chaves distingue
essa política coletiva dos contadores antigos, que expiram normalmente.

Os novos limitadores **não usam IP**, socket, headers de encaminhamento nem
`PUBLIC_TRUSTED_PROXY_CIDRS`. Continuam protegidos sem identificar IP real no Render;
falsificar ou omitir headers não muda os orçamentos. O `trust proxy` global do Express
e os limitadores do chat são consumidores independentes e requerem revisão própria;
essa política não altera suas configurações ou corrige seus riscos.

Testes adicionais permanentes: `public-request-policy.test.js`,
`public-request-integration.test.js`, `public-request-browser.test.js` e
`public-limit-collective.test.js` (inclui carga sintética e quatro processos).
