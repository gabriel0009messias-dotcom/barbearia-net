const { executionScope } = require('./executionScope');

// Local control only. No SQL issuer, supervisor enrollment or durable gate API.
function createCapabilityCoordinator(scope) {
  const resources = new Map();
  let closing;
  function register(name, stop) {
    if (typeof stop !== 'function') throw Error('Capability requires a stop operation.');
    const capability = scope.registerCapability(name);
    let completion;
    const close = () => {
      if (completion) return completion;
      // stop must synchronously fence scheduling before returning its completion.
      try { completion = Promise.resolve(stop()).then(() => { capability.close(); resources.delete(close); }); }
      catch (error) { completion = Promise.reject(error); }
      completion.catch(() => scope.blockCertification('CAPABILITY_CLOSE_FAILED:' + name));
      return completion;
    };
    resources.set(close, name);
    return close;
  }
  function drain({ timeoutMs } = {}) {
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) throw Error('Invalid drain timeout.');
    scope.beginDrain();
    if (!closing) {
      const pending = [...resources.keys()].map(close => close());
      closing = Promise.all(pending).then(() => scope.drain());
      closing.catch(() => {});
    }
    if (timeoutMs === undefined) return closing;
    let timer;
    return Promise.race([closing, new Promise(resolve => {
      timer = setTimeout(() => resolve(Object.freeze({ drained: false, state: scope.snapshot().state })), timeoutMs);
    })]).finally(() => clearTimeout(timer));
  }
  return Object.freeze({ register, drain, sealClosedScope: scope.sealClosedScope,
    // Persistent integration is deliberately absent, not an environment toggle.
    persistentEmissionEnabled: false, activationBlocker: '3B_PERMISSION_SEPARATION_REQUIRED' });
}
const coordinator = createCapabilityCoordinator(executionScope);
const scopes = new WeakMap([[executionScope, coordinator]]);
function coordinatorFor(scope) {
  if (!scopes.has(scope)) scopes.set(scope, createCapabilityCoordinator(scope));
  return scopes.get(scope);
}
module.exports = { createCapabilityCoordinator, coordinator, coordinatorFor };
