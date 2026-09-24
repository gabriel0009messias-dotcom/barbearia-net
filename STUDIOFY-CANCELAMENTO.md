# Cancelamento público — implementação local

O cliente recebe o botão **Cancelar agendamento** após reservar e na área **Meus agendamentos**. A confirmação usa um diálogo com **Voltar** e **Confirmar cancelamento**. Abrir o diálogo, voltar ou consultar uma reserva não altera seu status.

## Segurança e acesso

- Cada nova reserva pública recebe 32 bytes aleatórios criptográficos, representados por um token hexadecimal de 64 caracteres. O banco armazena somente SHA-256, na tabela `public_booking_access`.
- As consultas e cancelamentos recebem o token no corpo JSON. Não existe cancelamento público por ID. A resposta de criação pública não expõe o ID sequencial da reserva.
- O link privado contém o token no fragmento `#reserva=...`, que não é enviado no pedido HTTP da página. O navegador retira o fragmento após lê-lo. A página e as respostas privadas desabilitam referência/cache quando aplicável.
- Quem possui o link pode consultar/cancelar aquela reserva. O link deve ser tratado como uma credencial e não compartilhado. Não há listagem por nome, telefone ou ID.
- **Meus agendamentos** usa os tokens guardados neste navegador, com páginas de até 20 consultas. Exibe as reservas futuras e as ações permitidas pelo backend. Para outro aparelho, usar o link privado guardado. Limpar os dados do navegador remove essa lista local; não cancela as reservas.
- Reservas antigas e reservas criadas pelo painel não recebem retroativamente uma credencial pública nem são expostas por telefone. Continuam sob gestão do estabelecimento.

## Regras e persistência

O dono configura **Configurações → Cancelamento pelo cliente → Antecedência mínima (minutos)**. O padrão é zero: permitido antes do início. A regra também vale para reservas existentes e é validada novamente na confirmação pelo backend. Não é permitido cancelar reserva já cancelada, concluída, com falta ou cujo atendimento começou.

A transação bloqueia a reserva e lê a regra atual. A atualização define `status='cancelado'`; nenhum registro é apagado. A disponibilidade já considera apenas reservas confirmadas. O trigger existente cancela o lembrete na mesma transação. O painel recebe o novo status na próxima atualização automática (até 30 segundos) ou ao recarregar.

O worker coordena cancelamento e envio com bloqueio da linha do agendamento: um cancelamento efetivado antes do envio impede a mensagem. Se a entrega ao provedor já começou, não é possível recolher uma mensagem; a conclusão do cancelamento aguarda essa operação. A confirmação de cancelamento não mantém um envio pendente elegível.

## Banco, arquivos e testes

Nova migration aditiva: `backend/database/migrations/006_public_cancellation.sql`. Adiciona a antecedência por conta e a tabela de hashes. Não altera migrations anteriores nem apaga reservas/lembretes existentes.

Regras novas em `backend/services/publicBookings.js`; integração em `backend/studiofyRoutes.js`; interface em `backend/public/agendar.js`, `agendar.html`, `studiofy.js`, `studiofy.css` e versões de assets em `studiofy.html`.

Suíte completa local: **200 testes aprovados, zero falhas, zero ignorados**. Log: `.tmp/studiofy-cancel-all-tests.log`. Casos novos cobrem confirmação obrigatória, cancelamento, horário liberado, lembrete cancelado sem envio, tentativa duplicada, tokens inválidos, isolamento mesmo com telefone igual, status concluído/falta, limite exato de antecedência, permissões da configuração e duas confirmações concorrentes. Chromium verifica o diálogo, Voltar, cancelamento pela lista, link privado em outro contexto de navegador, reflexo no painel e largura móvel.

Prévia local: `http://127.0.0.1:3018/agendar/studiofy-demo`. Banco exclusivo local, dados fictícios, sem workers de envio, cobrança ou acesso à produção. Nenhum commit, push ou deploy desta funcionalidade foi realizado.
