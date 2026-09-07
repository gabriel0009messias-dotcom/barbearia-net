const { query } = require('../database/pool');

async function createLog({ level, source, message, context = {} }) {
  await query(
    'INSERT INTO logs (nivel, origem, mensagem, contexto) VALUES ($1, $2, $3, $4::jsonb)',
    [level, source, message, JSON.stringify(context)]
  );
}

module.exports = {
  createLog,
};
