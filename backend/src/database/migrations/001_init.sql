CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  codigo TEXT NOT NULL UNIQUE,
  valor_centavos INTEGER NOT NULL,
  moeda TEXT NOT NULL DEFAULT 'BRL',
  frequencia INTEGER NOT NULL DEFAULT 1,
  tipo_frequencia TEXT NOT NULL DEFAULT 'months',
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  mercado_pago_plan_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_fantasia TEXT NOT NULL,
  responsavel_nome TEXT NOT NULL,
  documento TEXT,
  email TEXT NOT NULL UNIQUE,
  telefone TEXT,
  status TEXT NOT NULL DEFAULT 'ativo',
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID REFERENCES clientes(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  telefone TEXT,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assinaturas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  plano_id UUID NOT NULL REFERENCES planos(id),
  referencia_externa TEXT NOT NULL UNIQUE,
  mercado_pago_preapproval_id TEXT UNIQUE,
  mercado_pago_checkout_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  billing_status TEXT NOT NULL DEFAULT 'pending',
  access_status TEXT NOT NULL DEFAULT 'pending',
  dia_vencimento INTEGER,
  grace_days INTEGER NOT NULL DEFAULT 4,
  extra_grace_days INTEGER NOT NULL DEFAULT 0,
  current_period_start DATE,
  current_period_end DATE,
  next_due_date DATE,
  grace_until DATE,
  last_payment_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  block_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pagamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  assinatura_id UUID NOT NULL REFERENCES assinaturas(id) ON DELETE CASCADE,
  mercado_pago_payment_id TEXT,
  mercado_pago_authorized_payment_id TEXT,
  status TEXT NOT NULL,
  status_detail TEXT,
  valor_centavos INTEGER NOT NULL,
  moeda TEXT NOT NULL DEFAULT 'BRL',
  due_date DATE,
  paid_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mercado_pago_payment_id),
  UNIQUE (mercado_pago_authorized_payment_id)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topico TEXT NOT NULL,
  acao TEXT,
  recurso_id TEXT,
  assinatura TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ,
  erro TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nivel TEXT NOT NULL,
  origem TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  contexto JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
CREATE INDEX IF NOT EXISTS idx_clientes_status ON clientes(status);
CREATE INDEX IF NOT EXISTS idx_assinaturas_cliente ON assinaturas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_assinaturas_status ON assinaturas(status, access_status, billing_status);
CREATE INDEX IF NOT EXISTS idx_assinaturas_next_due_date ON assinaturas(next_due_date);
CREATE INDEX IF NOT EXISTS idx_pagamentos_assinatura ON pagamentos(assinatura_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pagamentos_status ON pagamentos(status);
CREATE INDEX IF NOT EXISTS idx_webhooks_recurso ON webhooks(topico, recurso_id, created_at DESC);
