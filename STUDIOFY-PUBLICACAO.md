# Publicação do Studiofy

A aplicação usa `backend/app.js`, PostgreSQL e `backend/public`. A migration nova é `005_studiofy.sql`; ela é aplicada numa transação antes de iniciar o servidor. Não executar o bridge local nem a demonstração como serviço de produção.

## Preparação e recuperação

- Backup do schema do aplicativo salvo fora do Git, na pasta local ignorada `.tmp/`, com manifesto SHA-256. Nenhum backup, dado de produção ou acesso de demonstração faz parte desta publicação.
- Backup restaurado em PostgreSQL local separado. Migration 005 ensaiada sobre os dados restaurados. Os campos anteriores das 14 tabelas de dados foram comparados antes/depois e permaneceram idênticos.
- Versão anterior à reformulação: `3a3bf9acb9cc1d382b4e6ff07ce8b991d9815258`.
- Se houver falha no startup, a transação de migrations reverte automaticamente. Para regressão de aplicação, restaurar o deploy anterior no Render, preservando o banco e a migration aditiva; não apagar colunas nem recriar o banco para voltar o código.
- Se for necessária recuperação de banco, restaurar primeiro o backup em um banco separado e validar. Preservar os registros posteriores ao backup antes de qualquer troca. Não executar restauração destrutiva sobre produção em funcionamento.

## Validação operacional

`/health` e `/api/health` informam a versão (`RENDER_GIT_COMMIT`) e os horários de início, último ciclo concluído e último erro do worker. Não informam segredos. Comparar dois ciclos concluídos para verificar atividade e acesso do worker ao PostgreSQL.

Mercado Pago mantém plano e regras existentes. Conferir configuração sem iniciar checkout ou cobrança real. Evolution mantém o adaptador existente; não enviar mensagem para testar sem autorização específica.

Lembretes ficam em `appointment_reminders`, criados/atualizados na transação do agendamento para data/hora em `America/Sao_Paulo` menos 20 minutos. Reiniciar o processo não remove esses registros. Em entrega incerta, não há reenvio automático.

O `render.yaml` declara plano gratuito. Se esse for o plano efetivo, suspensões por inatividade interrompem o processamento enquanto o serviço está parado. A persistência evita perder o registro, mas não garante envio pontual com o servidor suspenso. Para execução contínua, verificar o plano efetivo e a disponibilidade do serviço antes de prometer entrega exata.

As credenciais da demonstração local não são enviadas ao GitHub nem provisionadas em produção. Testes automatizados usam schemas isolados e provedores simulados; os scripts locais de auditoria/backup não são publicados.
