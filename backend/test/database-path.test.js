const { test } = require('node:test');
const assert = require('node:assert/strict');
const { connectionConfig } = require('../database/config');

test('PostgreSQL obrigatorio sem fallback local, inclusive no Render', () => {
  for (const env of [{}, { RENDER: 'true' }, { NODE_ENV: 'production' }]) assert.throws(() => connectionConfig(env), /DATABASE_URL/);
});
test('URL interna do Render usa rede privada; externa usa TLS validado', () => {
  const internal = connectionConfig({ DATABASE_URL: 'postgresql://user:pass@dpg-example/db' });
  assert.equal(internal.ssl, false);
  const external = connectionConfig({ DATABASE_URL: 'postgresql://user:pass@dpg-example.oregon-postgres.render.com/db' });
  assert.deepEqual(external.ssl, { rejectUnauthorized: true });
});
test('parametros SSL explicitos sao respeitados sem sobrescrever configuracao', () => {
  const result = connectionConfig({ DATABASE_URL: 'postgresql://user:pass@host/db?sslmode=verify-full' });
  assert.equal(result.ssl, undefined);
  assert.throws(() => connectionConfig({ DATABASE_URL: 'postgresql://user:pass@x.render.com/db?sslmode=disable' }), /SSL/);
});
test('identificadores e protocolo invalidos sao rejeitados', () => {
  assert.throws(() => connectionConfig({ DATABASE_URL: 'sqlite:file' }), /PostgreSQL/);
  assert.throws(() => connectionConfig({ DATABASE_URL: 'postgresql://localhost/db', DATABASE_SCHEMA: 'public;DROP TABLE x' }), /SCHEMA/);
});
