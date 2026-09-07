# Barbearia SaaS

Sistema SaaS multi-tenant para barbearias e saloes com:

- backend oficial em `Node.js + Express`
- frontend oficial em `React + Vite`
- banco oficial em `PostgreSQL`
- autenticacao com `JWT + bcrypt`
- pagamentos com `Mercado Pago`
- integracao de WhatsApp via `Evolution API`

## Estado atual

O projeto foi consolidado para a arquitetura oficial sem apagar a base legada.

Ja esta pronto nesta parte:

- `backend/src/server.js` criado e funcionando estruturalmente
- `GET /api/health`
- cadastro e login JWT
- isolamento por `salon_id`
- CRUDs oficiais de servicos, profissionais, clientes, bloqueios e agendamentos
- dashboard oficial
- frontend React + Vite com build validado em 19 de agosto de 2026
- `render.yaml` atualizado para o monorepo oficial

Ainda depende de configuracao externa para funcionar de ponta a ponta:

- `DATABASE_URL` de um PostgreSQL ativo
- `JWT_SECRET`
- `MERCADO_PAGO_ACCESS_TOKEN`
- `MERCADO_PAGO_WEBHOOK_SECRET`
- `EVOLUTION_API_URL`
- `EVOLUTION_API_KEY`
- `SUPER_ADMIN_EMAIL`
- `SUPER_ADMIN_PASSWORD`

## Estrutura principal

```text
backend/
  src/
    app.js
    server.js
    config/
    database/
    middlewares/
    repositories/
    routes/
    services/
painel/
  src/
  index.html
  vite.config.mjs
render.yaml
```

## Variaveis de ambiente

Use [backend/.env.example](C:/Users/User/Desktop/barbearia/backend/.env.example:1) como base.

Exemplo:

```env
DATABASE_URL=postgres://user:password@localhost:5432/barbearia
JWT_SECRET=troque-esta-chave
MERCADO_PAGO_ACCESS_TOKEN=
MERCADO_PAGO_WEBHOOK_SECRET=
EVOLUTION_API_URL=
EVOLUTION_API_KEY=
PORT=3000
FRONTEND_URL=http://localhost:5173
APP_URL=http://localhost:3000
SUPER_ADMIN_EMAIL=admin@barbearia.local
SUPER_ADMIN_PASSWORD=troque-esta-senha
```

Variaveis opcionais do legado, apenas se voce ainda precisar desses fluxos:

```env
LEGACY_ADMIN_EMAIL=
LEGACY_ADMIN_PASSWORD=
LEGACY_DEMO_EMAIL=
LEGACY_DEMO_PASSWORD=
PIX_KEY=
PIX_KEY_DISPLAY=
PIX_HOLDER_NAME=
PIX_CITY=SAO PAULO
PIX_COPY_PASTE=
PIX_QR_CODE_IMAGE_URL=/assets/pix-qr-fixo.png
```

## Execucao local

### Backend

```bash
cd backend
npm install
npm run migrate
npm start
```

### Frontend

```bash
cd painel
npm install
npm run dev
```

### Build de producao do frontend

```bash
cd painel
npm run build
```

## Endpoints principais

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/dashboard`
- `GET|POST|PUT|DELETE /api/services`
- `GET|POST|PUT|DELETE /api/professionals`
- `GET|POST|PUT|DELETE /api/clients`
- `GET|POST|DELETE /api/blocked-times`
- `GET|POST|PUT|DELETE /api/appointments`
- `GET /api/appointments/availability`
- `GET /api/subscriptions/current`
- `POST /api/payments/webhook`
- `GET /api/whatsapp/status`

## Render

O arquivo [render.yaml](C:/Users/User/Desktop/barbearia/render.yaml:1) agora builda:

1. usa `rootDir: backend`
2. builda o frontend em `painel`
3. instala o backend em `backend`
4. sobe o backend servindo a API e o build do React

## Seguranca

Durante a auditoria foram encontrados segredos reais no legado.
Essas credenciais devem ser consideradas comprometidas e precisam ser regeneradas antes da producao.

O sistema oficial nao deve usar:

- SQLite como banco final
- Asaas como gateway final
- segredos hardcoded em codigo
- `.env` versionado no GitHub
