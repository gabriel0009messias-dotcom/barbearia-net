// Permanent local subprocess fixture. No database or external transport.
function start(context) {
  context.assertOpen();
  const http = require('node:http');
  const effects = Object.freeze({ listener: 1, worker: 1, timer: 1, booking: 0, webhook: 0, conversation: 0, database: 0, migration: 0 });
  const server = http.createServer((req,res) => {
    if (!context.isOpen()) { res.writeHead(503); res.end(); return; }
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: true, effects, pid: process.pid, envKeys: Object.keys(process.env).sort() }));
  });
  const timer = setInterval(() => {},1000);
  const stop = () => { clearInterval(timer); return new Promise(resolve => server.close(resolve)); };
  context.onShutdown(stop);
  server.listen(0,'127.0.0.1',() => { if (context.isOpen()) context.onReady(server.address().port); else stop(); });
  return { stop };
}
module.exports = { start };
