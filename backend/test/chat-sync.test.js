const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function clock() {
  let now = 0, id = 0; const timers = new Map(), events = new Map();
  const document = { hidden: false, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const window = { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const context = { document, window, Date: { now: () => now }, setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/chat-sync.js'), 'utf8'), context);
  return { document, events, timers, create: window.StudiofyChatSync.create, delay: () => Math.min(...[...timers.values()].map(t => t.at - now)),
    advance(ms) { now += ms; const due = [...timers].filter(([, t]) => t.at <= now); return Promise.all(due.map(([id, t]) => { timers.delete(id); return t.fn(); })); } };
}

test('2C.4: agendamento serial, pausa e retomada por visibilidade', async () => {
  const c = clock(); let calls = 0, release;
  const sync = c.create({ interval: 8000, enabled: () => true, task: () => { calls++; return new Promise(r => { release = r; }); } });
  sync.start(); assert.equal(c.delay(), 8000);
  const pending = c.advance(8000); assert.equal(calls, 1);
  sync.wake(); await c.advance(0); assert.equal(calls, 1);
  c.document.hidden = true; c.events.get('visibilitychange')(); release(); await pending;
  assert.equal(c.timers.size, 0); await c.advance(100000); assert.equal(calls, 1);
  c.document.hidden = false; c.events.get('visibilitychange')(); const resumed = c.advance(0); assert.equal(calls, 2); release(); await resumed;
  sync.dispose(); assert.equal(c.timers.size, 0); assert.equal(c.events.size, 0);
});

test('2C.4: backoff exponencial, teto, Retry-After e recuperação', async () => {
  const c = clock(); let failing = true, retryAfterMs = 0, errors = 0, successes = 0;
  const sync = c.create({ interval: 8000, enabled: () => true, task: async () => { if (failing) throw { retryAfterMs }; }, failed: () => errors++, recovered: () => successes++ });
  sync.start(); await c.advance(8000); assert.equal(c.delay(), 16000);
  await c.advance(16000); assert.equal(c.delay(), 32000);
  await c.advance(32000); assert.equal(c.delay(), 64000);
  await c.advance(64000); assert.equal(c.delay(), 120000);
  await c.advance(120000); assert.equal(c.delay(), 120000);
  retryAfterMs = 180000; await c.advance(120000); assert.equal(c.delay(), 180000);
  sync.wake(); assert.equal(c.delay(), 180000); assert.equal(errors, 6);
  failing = false; await c.advance(180000); assert.equal(c.delay(), 8000); assert.equal(successes, 1);
  sync.dispose();
});

test('2C.4: estado desabilitado não consulta nem agenda trabalho', async () => {
  const c = clock(); let enabled = false, count = 0;
  const sync = c.create({ interval: 20000, enabled: () => enabled, task: async () => count++ });
  sync.start(); assert.equal(c.timers.size, 0); enabled = true; sync.start(); await c.advance(20000); assert.equal(count, 1);
  enabled = false; await c.advance(20000); assert.equal(count, 1); assert.equal(c.timers.size, 0); sync.dispose();
});

for (const interval of [8000, 20000]) test(`2C.4: intervalo de ${interval} ms não consulta antes do prazo`, async () => {
  const c = clock(); let calls = 0;
  const sync = c.create({ interval, enabled: () => true, task: async () => { calls++; } });
  sync.start(); await c.advance(interval - 1); assert.equal(calls, 0);
  await c.advance(1); assert.equal(calls, 1); assert.equal(c.delay(), interval);
  await c.advance(interval - 1); assert.equal(calls, 1);
  await c.advance(1); assert.equal(calls, 2); sync.dispose();
});
