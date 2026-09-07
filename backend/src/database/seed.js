const env = require('../config/env');
const { ROLES } = require('../config/constants');
const { query } = require('./pool');
const { hashPassword } = require('../utils/password');

async function seedPlan() {
  await query(
    `INSERT INTO planos (nome, codigo, valor_centavos, moeda, frequencia, tipo_frequencia, ativo)
     VALUES ($1, 'plano-mensal', $2, 'BRL', 1, 'months', TRUE)
     ON CONFLICT (codigo)
     DO UPDATE SET
       nome = EXCLUDED.nome,
       valor_centavos = EXCLUDED.valor_centavos,
       updated_at = NOW()`,
    [env.defaultPlanName, env.defaultPlanAmountCents]
  );
}

async function seedConfigurations() {
  await query(
    `INSERT INTO configuracoes (chave, valor)
     VALUES ('billing_rules', $1::jsonb)
     ON CONFLICT (chave)
     DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
    [JSON.stringify({ graceDays: env.graceDays, amountCents: env.defaultPlanAmountCents })]
  );
}

async function seedSuperAdmin() {
  const passwordHash = await hashPassword(env.superAdminPassword);

  await query(
    `INSERT INTO usuarios (nome, email, telefone, senha_hash, papel, ativo)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     ON CONFLICT (email)
     DO UPDATE SET
       nome = EXCLUDED.nome,
       telefone = EXCLUDED.telefone,
       senha_hash = EXCLUDED.senha_hash,
       papel = EXCLUDED.papel,
       ativo = TRUE,
       updated_at = NOW()`,
    [env.superAdminName, env.superAdminEmail.toLowerCase(), env.superAdminPhone, passwordHash, ROLES.SUPER_ADMIN]
  );
}

async function seedDatabase() {
  await seedPlan();
  await seedConfigurations();
  await seedSuperAdmin();
}

module.exports = {
  seedDatabase,
};
