(() => {
  'use strict';
  // One scheduled task per stream. Manual actions share its in-flight promise.
  function create({ interval, enabled, task, failed = () => {}, recovered = () => {} }) {
    let timer, running = null, disposed = false, failures = 0, nextAt = 0;
    function schedule(delay = interval) {
      clearTimeout(timer);
      if (!disposed && !document.hidden && enabled()) timer = setTimeout(tick, Math.max(delay, nextAt - Date.now()));
    }
    async function tick() {
      if (disposed || document.hidden || !enabled()) return;
      if (running) return;
      if (Date.now() < nextAt) { schedule(); return; }
      running = (async () => {
        try { await task(); failures = 0; nextAt = 0; if (!disposed) recovered(); }
        catch (error) {
          failures++;
          nextAt = Date.now() + Math.max(Math.min(120000, interval * 2 ** Math.min(failures, 5)), error.retryAfterMs || 0);
          if (!disposed) failed(error);
        }
      })();
      try { await running; } finally { running = null; schedule(); }
    }
    function wake() { schedule(0); }
    function visibility() { if (document.hidden) clearTimeout(timer); else wake(); }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', wake);
    return {
      start: schedule, wake, idle: () => running || Promise.resolve(),
      stop() { clearTimeout(timer); },
      dispose() { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', wake); },
    };
  }
  function nearEnd(element) { return element.scrollHeight - element.scrollTop - element.clientHeight < 64; }
  function viewedEnd(element) {
    if (!element || document.hidden || !element.getClientRects().length || element.scrollHeight - element.scrollTop - element.clientHeight > 4) return false;
    const r = element.getBoundingClientRect(), v = window.visualViewport;
    return r.bottom > (v?.offsetTop || 0) && r.bottom <= (v?.offsetTop || 0) + (v?.height || innerHeight) + 1;
  }
  window.StudiofyChatSync = { create, nearEnd, viewedEnd };
})();
