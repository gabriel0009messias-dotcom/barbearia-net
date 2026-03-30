const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database(path.join(__dirname, 'barbearia.db'));

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

function garantirColuna(tabela, coluna, definicao) {
  db.all(`PRAGMA table_info(${tabela})`, [], (erro, colunas) => {
    if (erro) {
      console.error(`Nao consegui verificar colunas da tabela ${tabela}:`, erro.message);
      return;
    }

    const existe = colunas.some((item) => item.name === coluna);

    if (!existe) {
      db.run(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`, (alterErr) => {
        if (alterErr) {
          console.error(`Nao consegui adicionar a coluna ${coluna} em ${tabela}:`, alterErr.message);
        }
      });
    }
  });
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
    cliente_id INTEGER,
    servico_id INTEGER,
    data TEXT,
    hora TEXT,
    status TEXT,
    FOREIGN KEY(cliente_id) REFERENCES clientes(id),
    FOREIGN KEY(servico_id) REFERENCES servicos(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bloqueios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT,
    hora TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS assinaturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barbearia_nome TEXT NOT NULL,
    responsavel_nome TEXT NOT NULL,
    telefone TEXT NOT NULL,
    email TEXT,
    metodo_pagamento TEXT NOT NULL,
    dia_vencimento INTEGER NOT NULL,
    valor_mensal REAL NOT NULL DEFAULT 1,
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

  db.run(`CREATE TABLE IF NOT EXISTS servicos_assinatura (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assinatura_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    preco REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(assinatura_id) REFERENCES assinaturas(id) ON DELETE CASCADE
  )`);

  db.run(
    `INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('suporte_numero', '(11) 99999-9999')`
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
  garantirColuna('assinaturas', 'senha_hash', 'TEXT');
  garantirColuna('assinaturas', 'senha_salt', 'TEXT');

  db.run(`UPDATE assinaturas
          SET metodo_pagamento = 'pix'
          WHERE metodo_pagamento IS NULL
             OR lower(metodo_pagamento) <> 'pix'`);

  db.run(`UPDATE assinaturas
          SET dia_vencimento = CASE
            WHEN dia_vencimento = 19 THEN 12
            WHEN dia_vencimento = 26 THEN 24
            ELSE dia_vencimento
          END
          WHERE dia_vencimento NOT IN (5, 12, 24)`);

  popularServicos();
});

module.exports = db;
