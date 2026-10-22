// Process-local startup authority. No environment variable grants admission.
// Only the fixed executor bootstrap installs this boundary, before app imports.
let context;
function install({ identity, schemaAlreadyPrepared, confirmEnrollment }) {
  if (context || !identity || typeof schemaAlreadyPrepared !== 'function' || typeof confirmEnrollment !== 'function') throw Error('Invalid supervision boundary.');
  let admitted = false, closed = false, ready, close, completion;
  const value = Object.freeze({ identity: Object.freeze({ ...identity }),
    isOpen: () => admitted && !closed,
    assertOpen() { if (!admitted || closed) throw Object.assign(Error('Supervised admission closed.'), { code: 'INSTANCE_ADMISSION_CLOSED' }); },
    schemaAlreadyPrepared, confirmEnrollment,
    onReady(port) { ready?.(port); },
    onShutdown(handler) { close = handler; if (closed) handler(); },
  });
  context = value;
  return Object.freeze({
    open() { if (closed || admitted) throw Error('Bootstrap cannot reopen.'); admitted = true; },
    close() {
      if (closed) return completion;
      closed = true; admitted = false;
      completion = Promise.resolve().then(() => close?.());
      completion.catch(() => {});
      return completion;
    },
    setReady(handler) { ready = handler; },
    value,
  });
}
const current = () => context;
const admissionAllowed = () => !context || context.isOpen();
function assertRuntimeImport() { context?.assertOpen(); }
module.exports = { install, current, admissionAllowed, assertRuntimeImport };
