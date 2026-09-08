# Diagnóstico e atualização do WhatsApp

## Evidências desta análise

- O Blueprint executa `npm start` em `backend`, que inicia `app.js` e usa `routes.js` / `evolutionApi.js`. A implementação em `src/services/evolutionApiService.js` pertence ao outro servidor (`npm run dev`), não ao fluxo de `barbeiro.html` iniciado pelo Blueprint.
- A URL do Blueprint é `https://evolution-api-3-bp28.onrender.com`. O DNS resolveu. Duas consultas públicas à raiz expiraram após 20 segundos cada e uma terceira após 8 segundos. No teste comparativo, o backend da barbearia respondeu HTTP 200 em 356 ms e render.com em 408 ms.
- Uma consulta posterior à mesma raiz respondeu HTTP 200 em 608 ms e informou versão **2.3.7**. A indisponibilidade transitória ocorreu antes de qualquer autenticação ou pareamento. É compatível com cold start; a causa interna e o plano contratado precisam ser confirmados nos Events/Logs da Evolution no Render.
- A URL não estava permanentemente inválida e o serviço não permaneceu offline. Não há evidência para atribuir essa indisponibilidade ao número ou à chave.
- `EVOLUTION_API_URL` e `EVOLUTION_API_KEY` não estavam presentes no ambiente local carregado. Isso NÃO comprova ausência no Render. A chave e as variáveis privadas de produção não foram acessadas.
- O código forçava timeout mínimo de 90s, enquanto o fluxo inteiro tinha orçamento de 60s e o navegador 70s. O erro genérico não identificava o endpoint nem preservava a causa da falha de rede. Não aumentamos esses limites para encobrir a indisponibilidade.

## Correções

- Validação do endereço base, sem credenciais, query string ou caminho `/manager` / `/instance`.
- Mensagens públicas controladas por status HTTP e etapa. Uma falha 401/403 da Evolution retorna 502 ao painel, sem invalidar o login do barbeiro. HTML de proxy também é classificado pelo HTTP.
- Logs estruturados de início, endpoint, instância, identificador da tentativa, HTTP, resposta, duração, stack e causa. Chaves, senhas, tokens, hashes, cabeçalhos, QR e pairing code são sanitizados. O telefone não aparece na URL dos logs.
- Criação não é repetida automaticamente após falha ambígua. Se houver conflito (inclusive o 403 específico de nome duplicado na 2.3.7), a existência é confirmada por nova consulta.
- Lista de instâncias com formato inesperado causa erro explícito, em vez de ser interpretada como lista vazia.
- QR aceita geração inicialmente vazia, prioriza a imagem base64 e retorna HTTP de erro quando falha.
- Logout trata como sucesso o HTTP 400 específico de instância já desconectada da Evolution 2.3.7.
- Preservados: autenticação do barbeiro, isolamento por assinatura, normalização brasileira, criação com `qrcode: false`, reutilização, polling e consulta de status após recarregar a página.

## Variáveis no serviço backend do Render

| Variável | Valor |
| --- | --- |
| `EVOLUTION_API_URL` | `https://evolution-api-3-bp28.onrender.com` |
| `EVOLUTION_API_KEY` | Mesmo segredo de `AUTHENTICATION_API_KEY` do serviço Evolution; use a chave global, não o token de uma instância |
| `PUBLIC_APP_URL` | `https://barbearia-net.onrender.com` |
| `EVOLUTION_API_TIMEOUT_MS` | `20000` |
| `EVOLUTION_API_RETRY_ATTEMPTS` | `1` |
| `EVOLUTION_API_RETRY_DELAY_MS` | `2000` |

O código agora respeita o timeout configurado (sem mínimo forçado de 90s). Mantém 60s para o fluxo completo, 12s para status, 15s para logout e 70s no navegador para iniciar conexão. As consultas adicionais ao código vazio são limitadas e não recriam nem encerram a instância.

No serviço Evolution, confira `AUTHENTICATION_API_KEY`, os dados de PostgreSQL/Redis e a persistência conforme a instalação existente. Não copie a chave para HTML, JavaScript do painel ou Git. Nenhuma alteração nas variáveis de pagamentos, banco ou outros módulos do backend é necessária para esta correção.

## Deploy e diagnóstico de produção

1. Publique os arquivos alterados e faça novo deploy do backend. O Blueprint continua com `rootDir: backend`, `startCommand: npm start`. Em um serviço existente, confira também os valores efetivos em **Environment**; editar o YAML local não altera sozinho o ambiente implantado.
2. No Shell do backend no Render, execute `node scripts/diagnose-evolution.js`. É somente leitura: consulta DNS, raiz e `fetchInstances`, sem criar nem desconectar sessões. Não cole chaves na linha de comando.
3. A raiz deve retornar JSON HTTP 200 com a versão; `fetchInstances` deve retornar HTTP 200. Se apenas a raiz funcionar, investigue autenticação e banco da Evolution. Se houver timeout antes do HTTP, confira inicialização, Events, reinícios, porta e disponibilidade do serviço. Se `connect` retornar HTTP 200 sem QR/pairing, investigue os logs do Baileys e sua comunicação com WhatsApp no serviço Evolution.
4. Se a Evolution estiver no plano Free, o Render pode suspendê-la após 15 minutos sem tráfego de entrada. Uma sessão de WhatsApp exige que o serviço permaneça disponível; para produção contínua, use uma instância que não hiberne e armazenamento persistente. `EVOLUTION_ALWAYS_ONLINE=true` é uma configuração do WhatsApp, não impede o Render de suspender o serviço.

## Testes após a atualização

1. Entre em `barbeiro.html`, informe `5575981218107` e clique em **Conectar WhatsApp**. Os logs devem percorrer `fetchInstances`, eventualmente `create`, `connectionState` e `connect`.
2. O envio para a Evolution é `GET /instance/connect/barbearia-ID?number=5575981218107`, com autenticação `apikey` apenas no backend.
3. No celular: **Aparelhos conectados > Conectar um aparelho > Conectar com número de telefone**. Digite o código exibido.
4. Aguarde **WhatsApp conectado**, recarregue a página e confirme que o estado continua conectado.
5. Clique em **Desconectar WhatsApp**, reconecte por código e confira que a mesma instância foi reutilizada.
6. Desconecte e use **Conectar usando QR Code**. Leia o QR no celular e confirme o estado após recarregar.
7. Teste com uma assinatura sem instância e outra com instância existente. Não apague uma instância de produção para simular o caso.

Resultado local: `npm test` passou com **39 testes, zero falhas e zero testes ignorados**. Após reforçar a sanitização dos detalhes dos erros, os 9 testes de transporte e logs também foram reexecutados e passaram. Os testes usam banco isolado, Evolution simulada e Chrome real. Cobrem os fluxos acima, códigos atrasados, erros de rede/HTTP, ausência de configuração, concorrência, segurança dos logs e preservação do login. Não substituem o pareamento no telefone real nem a validação das variáveis privadas e da comunicação originada no Render.

## Fontes verificadas

- [Rotas oficiais da Evolution 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/instance.router.ts)
- [Criação, conexão, autenticação de fetchInstances e logout na 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/controllers/instance.controller.ts)
- [Suspensão e limites dos serviços Free no Render](https://render.com/docs/free)
