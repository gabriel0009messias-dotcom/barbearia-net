// Wakeups share one drain in this process. Durable claims and ownership remain
// responsible for safety across processes; periodic polling recovers missed work.
function createOutboxWorker(drain, { intervalMs = 15000, errorDelayMs = 1000, timers = globalThis, onError = () => {}, scope = require('../executionScope').executionScope } = {}) {
  let running = false, requested = false, stopped = false, scheduled = null, retryAt = 0;
  let flight;
  const completions = new Set();
  const schedule = () => {
    if (stopped || !scope.isOpen() || running || scheduled !== null || !requested) return;
    scheduled = timers.setTimeout(run, Math.max(0, retryAt - Date.now()));
    scheduled?.unref?.();
  };
  const wake = () => { if (!stopped && scope.isOpen()) { requested = true; schedule(); } };
  function run() {
    scheduled = null;
    if (stopped || !scope.isOpen() || running) return;
    running = true; requested = false;
    flight = scope.admitRoot('outbox.run', async () => {
      try { await drain(); retryAt = 0; }
      catch (error) { retryAt = Date.now() + errorDelayMs; onError(error); }
      finally { running = false; schedule(); }
    }, { canAdmit: () => !stopped });
    const completion = flight.completion;
    completions.add(completion);
    completion.then(() => completions.delete(completion));
    return flight;
  }
  const timer = timers.setInterval(wake, intervalMs); timer?.unref?.();
  const stop = () => { stopped = true; requested = false; timers.clearInterval(timer); if (scheduled !== null) timers.clearTimeout(scheduled); scheduled = null; return Promise.all([...completions]); };
  wake();
  return { wake, stop };
}
module.exports = { createOutboxWorker };
