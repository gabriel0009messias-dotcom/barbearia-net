const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../database.js'), 'utf8');

function iniciarBanco({ errorCode, persistentAvailable = false }) {
  const root = path.resolve(__dirname, '..');
  const configuredDirectory = path.resolve(__dirname, 'render-volume');
  const configuredFile = path.join(configuredDirectory, 'barbearia.db');
  const warnings = [];
  let opened;
  const fakeFs = {
    existsSync: (file) => file === configuredDirectory ? persistentAvailable : true,
    mkdirSync: () => { throw Object.assign(new Error('directory unavailable'), { code: errorCode }); },
    copyFileSync: () => assert.fail('Nao deve substituir um banco existente'),
  };
  const sqlite = { verbose: () => ({ Database: class {
    constructor(file) { opened = file; }
    serialize() {} // Nao abre nem altera bancos reais neste teste de inicializacao.
  } }) };
  vm.runInNewContext(source, {
    require: (name) => name === 'fs' ? fakeFs : name === 'sqlite3' ? sqlite : require(name),
    process: { env: { RENDER: 'true', DATABASE_PATH: configuredFile } },
    __dirname: root,
    module: { exports: {} },
    console: { log() {}, warn: (message) => warnings.push(message) },
  });
  return { opened, warnings, configuredFile, legacyFile: path.join(root, 'barbearia.db') };
}

test('Render sem disco: erros de permissao preservam o fallback legado e avisam sobre persistencia', () => {
  for (const errorCode of ['EACCES', 'EPERM', 'EROFS']) {
    const result = iniciarBanco({ errorCode });
    assert.equal(result.opened, result.legacyFile);
    assert.ok(result.warnings.some((message) => message.includes('temporario')));
  }
});

test('Render com disco: continua usando o banco configurado', () => {
  const result = iniciarBanco({ persistentAvailable: true });
  assert.equal(result.opened, result.configuredFile);
  assert.deepEqual(result.warnings, []);
});

test('erro inesperado de armazenamento nao fica escondido pelo fallback', () => {
  assert.throws(() => iniciarBanco({ errorCode: 'EIO' }), { code: 'EIO' });
});
