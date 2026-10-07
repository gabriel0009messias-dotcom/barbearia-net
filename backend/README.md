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
