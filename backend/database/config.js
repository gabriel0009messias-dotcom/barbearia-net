const { types } = require('pg');

function connectionConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL obrigatoria. Configure PostgreSQL; nao existe fallback para arquivo local.');
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL invalida.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL deve ser uma URL PostgreSQL.');
  const schema = env.DATABASE_SCHEMA || 'salaoflix';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('DATABASE_SCHEMA invalido.');
  const externalRender = url.hostname.endsWith('.render.com');
  const hasSslOptions = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].some(key => url.searchParams.has(key));
  if (externalRender && url.searchParams.get('sslmode') === 'disable') throw new Error('Conexoes externas ao Render exigem SSL.');
  return {
    connectionString: env.DATABASE_URL,
    ...(!hasSslOptions ? { ssl: externalRender ? { rejectUnauthorized: true } : false } : {}),
    max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000,
    options: `-c search_path=${schema},public -c timezone=UTC`,
    types: { getTypeParser(oid, format) {
      if (oid === 20 && format !== 'binary') return value => {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error('Inteiro do banco excede o limite seguro do JavaScript.');
        return number;
      };
      return types.getTypeParser(oid, format);
    } },
  };
}
module.exports = { connectionConfig };
