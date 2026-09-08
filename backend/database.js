const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const legacyDbPath = path.join(__dirname, 'barbearia.db');
const configuredDbPath =
  process.env.DATABASE_PATH ||
  (process.env.RENDER || process.env.RENDER_SERVICE_ID ? '/var/data/barbearia.db' : legacyDbPath);
let dbPath = path.resolve(configuredDbPath);

function garantirDiretorioDoBanco() {
  const dbDir = path.dirname(dbPath);

  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  } catch (error) {
    // Mantem compatibilidade com o servico existente sem disco montado.
    const deveUsarFallback = dbPath !== legacyDbPath && ['EACCES', 'EPERM', 'EROFS'].includes(error.code);

    if (!deveUsarFallback) {
      throw error;
    }

    dbPath = legacyDbPath;
    const fallbackDir = path.dirname(dbPath);

    if (!fs.existsSync(fallbackDir)) {
      fs.mkdirSync(fallbackDir, { recursive: true });
    }

    console.warn(`Sem permissao para usar ${dbDir}. Fallback para banco local em ${dbPath}.`);
    if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
      console.warn('[BANCO] Armazenamento local temporario no Render: alteracoes podem ser perdidas em reinicios e deploys. Configure um disco persistente ou banco externo para preservar os dados.');
    }
  }
}

function migrarBancoLegadoSeNecessario() {
  if (dbPath === legacyDbPath) {
    return;
  }

  if (fs.existsSync(dbPath) || !fs.existsSync(legacyDbPath)) {
    return;
  }

  fs.copyFileSync(legacyDbPath, dbPath);
  console.log(`Banco legado copiado para ${dbPath}`);
}

garantirDiretorioDoBanco();
migrarBancoLegadoSeNecessario();

console.log(`Usando banco em: ${dbPath}`);

const db = new sqlite3.Database(dbPath);

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

function carregarServicos() {
  const servicosPath = path.join(__dirname, 'servicos.json');
  return JSON.parse(fs.readFileSync(servicosPath, 'utf8'));
}

function popularServicos() {
  const servicos = carregarServicos();
  const stmt = db.prepare('INSERT OR IGNORE INTO servicos (id, nome, preco) VALUES (?, ?, ?)');

  servicos.forEach((servico) => {
    stmt.run(servico.id, servico.nome, servico.preco);
  });

  stmt.finalize();
}

const migracoesColunas = [];

function garantirColuna(tabela, coluna, definicao) {
  const migracao = allAsync(`PRAGMA table_info(${tabela})`).then((colunas) => {
    if (!colunas.some((item) => item.name === coluna)) {
      return runAsync(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
    }
  });
  migracoesColunas.push(migracao);
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    telefone TEXT UNIQUE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS servicos (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    preco REAL NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS agendamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assinatura_id INTEGER,
    cliente_id INTEGER,
    servico_id INTEGER,
    nome_cliente TEXT,
    telefone TEXT,
    servico_nome TEXT,
    preco REAL,
    data TEXT,
    hora TEXT,
    status TEXT,
    FOREIGN KEY(assinatura_id) REFERENCES assinaturas(id),
    FOREIGN KEY(cliente_id) REFERENCES clientes(id),
    FOREIGN KEY(servico_id) REFERENCES servicos(id)
  )`);

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agendamentos_confirmados_data_hora
          ON agendamentos (data, hora)
          WHERE status = 'confirmado'`);

  db.run(`CREATE TABLE IF NOT EXISTS bloqueios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assinatura_id INTEGER,
    data TEXT,
    hora TEXT,
    FOREIGN KEY(assinatura_id) REFERENCES assinaturas(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assinatura_id INTEGER NOT NULL,
    telefone TEXT NOT NULL,
    etapa TEXT NOT NULL,
    servico TEXT,
    preco REAL,
    nome TEXT,
    data TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(assinatura_id) REFERENCES assinaturas(id) ON DELETE CASCADE,
    UNIQUE(assinatura_id, telefone)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS assinaturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barbearia_nome TEXT NOT NULL,
    responsavel_nome TEXT NOT NULL,
    telefone TEXT NOT NULL,
    email TEXT,
    metodo_pagamento TEXT NOT NULL,
    dia_vencimento INTEGER NOT NULL,
    valor_mensal REAL NOT NULL DEFAULT 60,
    status TEXT NOT NULL DEFAULT 'pendente',
    suporte_numero TEXT NOT NULL,
    ultimo_pagamento TEXT,
    proximo_vencimento TEXT,
    observacoes TEXT,
    whatsapp_numero TEXT,
    whatsapp_status TEXT NOT NULL DEFAULT 'nao_configurado',
    whatsapp_session TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assinatura_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(assinatura_id) REFERENCES assinaturas(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_uniq
          ON password_reset_tokens (assinatura_id)
          WHERE used_at IS NULL`);

  db.run(`CREATE TABLE IF NOT EXISTS clientes_saas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf TEXT NOT NULL,
    email TEXT NOT NULL,
    telefone TEXT NOT NULL,
    asaas_customer_id TEXT NOT NULL UNIQUE,
    asaas_subscription_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'ativo',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS servicos_assinatura (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assinatura_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    preco REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(assinatura_id) REFERENCES assinaturas(id) ON DELETE CASCADE
  )`);

  db.run(
    `INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('suporte_numero', '+55 75 8317-9933')`
  );

  db.run(
    `INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('admin_pin', '5090')`
  );

  garantirColuna('assinaturas', 'whatsapp_numero', 'TEXT');
  garantirColuna('assinaturas', 'whatsapp_status', "TEXT NOT NULL DEFAULT 'nao_configurado'");
  garantirColuna('assinaturas', 'whatsapp_session', 'TEXT');
  garantirColuna('assinaturas', 'trial_usado', 'INTEGER NOT NULL DEFAULT 0');
  garantirColuna('assinaturas', 'trial_started_at', 'TEXT');
  garantirColuna('assinaturas', 'trial_expires_at', 'TEXT');
  garantirColuna('assinaturas', 'dias_funcionamento', "TEXT NOT NULL DEFAULT '1,2,3,4,5,6'");
  garantirColuna('assinaturas', 'horario_abertura', "TEXT NOT NULL DEFAULT '08:00'");
  garantirColuna('assinaturas', 'horario_almoco_inicio', "TEXT NOT NULL DEFAULT '12:00'");
  garantirColuna('assinaturas', 'horario_almoco_fim', "TEXT NOT NULL DEFAULT '13:00'");
  garantirColuna('assinaturas', 'horario_fechamento', "TEXT NOT NULL DEFAULT '18:00'");
  garantirColuna('assinaturas', 'localizacao_cidade', 'TEXT');
  garantirColuna('assinaturas', 'localizacao_rua', 'TEXT');
  garantirColuna('assinaturas', 'localizacao_referencia', 'TEXT');
  garantirColuna('assinaturas', 'senha_hash', 'TEXT');
  garantirColuna('assinaturas', 'senha_salt', 'TEXT');
  garantirColuna('assinaturas', 'whatsapp_bridge_token', 'TEXT');
  garantirColuna('assinaturas', 'whatsapp_ultimo_erro', 'TEXT');
  garantirColuna('assinaturas', 'whatsapp_ultimo_check_em', 'TEXT');
  garantirColuna('assinaturas', 'whatsapp_ultimo_qr_em', 'TEXT');
  garantirColuna('assinaturas', 'gateway_provider', 'TEXT');
  garantirColuna('assinaturas', 'gateway_status', 'TEXT');
  garantirColuna('assinaturas', 'gateway_external_reference', 'TEXT');
  garantirColuna('assinaturas', 'gateway_checkout_url', 'TEXT');
  garantirColuna('assinaturas', 'mercado_preapproval_id', 'TEXT');
  garantirColuna('assinaturas', 'mercado_payer_email', 'TEXT');
  garantirColuna('assinaturas', 'mercado_next_payment_date', 'TEXT');
  garantirColuna('assinaturas', 'mercado_last_payload', 'TEXT');
  garantirColuna('assinaturas', 'plano', "TEXT NOT NULL DEFAULT 'Plano Profissional'");
  garantirColuna('assinaturas', 'valor_plano', 'REAL NOT NULL DEFAULT 65');
  garantirColuna('assinaturas', 'status_assinatura', "TEXT NOT NULL DEFAULT 'PENDENTE'");
  garantirColuna('assinaturas', 'subscription_id', 'TEXT');
  garantirColuna('assinaturas', 'customer_id', 'TEXT');
  garantirColuna('assinaturas', 'payment_id', 'TEXT');
  garantirColuna('assinaturas', 'dias_atraso', 'INTEGER NOT NULL DEFAULT 0');
  garantirColuna('assinaturas', 'bloqueado', 'INTEGER NOT NULL DEFAULT 0');
  garantirColuna('assinaturas', 'data_bloqueio', 'TEXT');
  garantirColuna('assinaturas', 'trial', 'INTEGER NOT NULL DEFAULT 0');
  garantirColuna('assinaturas', 'data_vencimento', 'TEXT');
  garantirColuna('assinaturas', 'notification_history', 'TEXT');
  garantirColuna('agendamentos', 'lembrete_15_enviado_em', 'TEXT');
  garantirColuna('agendamentos', 'lembrete_7_enviado_em', 'TEXT');
  garantirColuna('agendamentos', 'assinatura_id', 'INTEGER');
  garantirColuna('agendamentos', 'nome_cliente', 'TEXT');
  garantirColuna('agendamentos', 'telefone', 'TEXT');
  garantirColuna('agendamentos', 'servico_nome', 'TEXT');
  garantirColuna('agendamentos', 'preco', 'REAL');
  garantirColuna('bloqueios', 'assinatura_id', 'INTEGER');

  // Os ALTER TABLE sao enfileirados nos callbacks do PRAGMA. Aguarde antes
  // de consultar as colunas novas ou aceitar requisicoes do painel.
  db.ready = Promise.all(migracoesColunas).then(async () => {
    await runAsync(`UPDATE assinaturas
          SET metodo_pagamento = 'pix'
          WHERE metodo_pagamento IS NULL
             OR lower(metodo_pagamento) <> 'pix'`);

    await runAsync(`UPDATE assinaturas
          SET plano = COALESCE(NULLIF(plano, ''), 'Plano Profissional'),
              valor_plano = COALESCE(valor_plano, 65),
              status_assinatura = CASE
                WHEN status = 'ativo' THEN 'ATIVA'
                WHEN status = 'bloqueado' THEN 'BLOQUEADA'
                ELSE COALESCE(NULLIF(status_assinatura, ''), 'PENDENTE')
              END,
              dias_atraso = COALESCE(dias_atraso, 0),
              bloqueado = CASE WHEN status = 'bloqueado' THEN 1 ELSE COALESCE(bloqueado, 0) END,
              trial = COALESCE(trial, 0),
              data_vencimento = COALESCE(data_vencimento, proximo_vencimento)`);

    await runAsync(`UPDATE assinaturas
          SET dia_vencimento = CASE
            WHEN dia_vencimento = 19 THEN 12
            WHEN dia_vencimento = 26 THEN 24
            ELSE dia_vencimento
          END
          WHERE dia_vencimento NOT IN (5, 12, 24)`);
  });

  popularServicos();
});

module.exports = db;
module.exports.runAsync = runAsync;
module.exports.getAsync = getAsync;
module.exports.allAsync = allAsync;
