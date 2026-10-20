// Wakeups share one drain in this process. Durable claims and ownership remain
// responsible for safety across processes; periodic polling recovers missed work.
function createOutboxWorker(drain, { intervalMs = 15000, errorDelayMs = 1000, timers = globalThis, onError = () => {} } = {}) {
  let running = false, requested = false, stopped = false, scheduled = null, retryAt = 0;
  const schedule = () => {
    if (stopped || running || scheduled !== null || !requested) return;
    scheduled = timers.setTimeout(run, Math.max(0, retryAt - Date.now()));
    scheduled?.unref?.();
  };
  const wake = () => { if (!stopped) { requested = true; schedule(); } };
  async function run() {
    scheduled = null;
    if (stopped || running) return;
    running = true; requested = false;
    try { await drain(); retryAt = 0; }
    catch (error) { retryAt = Date.now() + errorDelayMs; onError(error); }
    finally { running = false; schedule(); }
  }
  const timer = timers.setInterval(wake, intervalMs); timer?.unref?.();
  const stop = () => { stopped = true; requested = false; timers.clearInterval(timer); if (scheduled !== null) timers.clearTimeout(scheduled); scheduled = null; };
  wake();
  return { wake, stop };
}
module.exports = { createOutboxWorker };
