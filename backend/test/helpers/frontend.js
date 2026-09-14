const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function assertFrontend(base) {
  const publicPath = path.resolve(__dirname, '../../public');
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal(await home.text(), fs.readFileSync(path.join(publicPath, 'index.html'), 'utf8'));

  // Request every shipped page and asset, including the relative CSS/JS URLs.
  const files = fs.readdirSync(publicPath).filter(name => /\.(html|css|js)$/.test(name));
  files.push('assets/pix-qr-fixo.png');
  for (const file of files) {
    const response = await fetch(`${base}/${file}?v=production`);
    assert.equal(response.status, 200, file);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(publicPath, file)), file);
  }
  for (const route of ['/arquivo-inexistente.js', '/pagina-inexistente', '/api/rota-inexistente', '/.env', '/package.json']) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
}

module.exports = { assertFrontend };
