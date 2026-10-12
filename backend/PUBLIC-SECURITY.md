# Segurança do cadastro e dos fluxos públicos

Base: 02b253415525c24da7d3e03f285aa4022e8c0a0c.

A personalização normaliza o telefone e verifica telefone/WhatsApp das outras contas sob o mesmo advisory lock transacional usado pelo cadastro. A própria conta é excluída da comparação. Conflitos retornam TELEFONE_JA_UTILIZADO e a transação não salva parcialmente.

GET /api/publico/assinaturas/:id/status exige a sessão existente no cabeçalho x-barbeiro-token e a titularidade do ID. Responde somente id e liberado. A contratação sem trial autentica antes do checkout e do acompanhamento; uma pendência sem sessão deve continuar pelo login. A senha não é persistida pelo acompanhamento.

O status tem limite global de 6000/minuto e por conta autenticada de 120/minuto, compartilhados em public_request_limits. IDs arbitrários não geram budgets por conta. Não utiliza IP.

Consultas privadas de conta, acesso, status e checkout recebem Cache-Control: no-store antes da autenticação. O logger HTTP registra apenas tipo fixo e status, sem mensagem bruta, body ou cabeçalhos. Serviços e profissionais públicos passam por DTOs explícitos.

## Limites arquiteturais preservados

O telefone público ainda é uma identidade de login; alterar ou remover esse contato pode mudar os identificadores aceitos para a própria conta. Esta correção não separa esses campos. A exclusividade é garantida entre os escritores de cadastro/personalização que usam o lock compartilhado; escritores externos de identidade precisam respeitar a mesma regra.

As sessões existentes ficam em memória por processo. Deploy/reinício pode exigir novo login, e múltiplas instâncias precisam preservar o roteamento de sessão existente. Os budgets são compartilhados no PostgreSQL independentemente dessas sessões. Limites globais podem afetar tráfego legítimo em picos e devem ser monitorados.

Nenhuma migration é necessária: usa as estruturas existentes da migration 012. Não altera WhatsApp/Evolution nem dados de produção.
