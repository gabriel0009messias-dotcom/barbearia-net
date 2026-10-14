const { randomUUID } = require('node:crypto');

// This stage accepts only these local dispatchers. No transport/provider is loaded.
const simulatedDispatchers = new WeakSet();
function composeMessage(row) {
  return `Olá, ${row.customer_name_snapshot}! 👋 Já se passaram 7 dias desde o seu atendimento de ${row.service_name_snapshot}. Que tal agendar novamente?`;
}

function createSimulatedDispatcher({ outcome = 'success', delayMs = 0 } = {}) {
  if (!['success', 'paused_success', 'before_dispatch_failure', 'uncertain', 'timeout', 'rejected'].includes(outcome) ||
      !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000) throw new Error('Invalid simulation');
  let released = false;
  const waiters = new Set();
  const dispatcher = Object.freeze({
    mode: 'simulated',
    // A local barrier makes concurrency tests deterministic without arbitrary sleeps.
    release() { released = true; for (const done of waiters) done(); },
    prepare(row) {
      if (outcome === 'before_dispatch_failure') throw new Error('Simulated preparation failure');
      return { text: composeMessage(row), recipient: row.phone_snapshot };
    },
    async dispatch(_message, { signal }) {
      if (signal.aborted) throw new Error('Simulation aborted');
      if (delayMs || outcome === 'timeout' || (outcome === 'paused_success' && !released)) await new Promise((resolve, reject) => {
        let timer;
        const abort = () => { clearTimeout(timer); waiters.delete(done); signal.removeEventListener('abort', abort); reject(new Error('Simulation aborted')); };
        const done = () => { clearTimeout(timer); waiters.delete(done); signal.removeEventListener('abort', abort); resolve(); };
        signal.addEventListener('abort', abort, { once: true });
        if (outcome === 'paused_success') waiters.add(done);
        else if (outcome !== 'timeout') timer = setTimeout(done, delayMs);
      });
      if (signal.aborted || outcome === 'uncertain') throw new Error('Simulated ambiguous result');
      return outcome === 'rejected' ? { status: 'rejected' } : { status: 'sent', id: 'simulated:' + randomUUID() };
    },
  });
  simulatedDispatchers.add(dispatcher);
  return dispatcher;
}

module.exports = { composeMessage, createSimulatedDispatcher, isSimulatedDispatcher: value => simulatedDispatchers.has(value) };
