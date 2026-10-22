const { randomUUID, randomBytes } = require('node:crypto');
const { invalid } = require('./protocol');

const requestFields = ['closure_request_id', 'closure_nonce', 'closure_capability'];
const sealFields = [...requestFields, 'seal_id', 'closure_generation'];
const pick = (message, names) => Object.fromEntries(names.map(name => [name, message[name]]));
const matches = (message, expected) => Object.keys(expected).every(name => message[name] === expected[name]);

// Callers are the fixed bootstrap/composition, never business payload handlers.
// Authentication and strict sequence checks precede receive() at both endpoints.
function createParentBridge({ protocol, send }) {
  let state = 'RUNNING', request, receipt;
  function fail() { state = 'FAILED'; }
  return Object.freeze({
    request() {
      if (state !== 'RUNNING') throw invalid();
      request = Object.freeze({ closure_request_id: randomUUID(), closure_nonce: randomBytes(32).toString('hex'),
        closure_capability: randomBytes(32).toString('hex') });
      state = 'CLOSE_REQUESTED';
      send(protocol.message('COOPERATIVE_CLOSE_REQUEST', request));
    },
    async receive(message) {
      if (state !== 'CLOSE_REQUESTED' || !matches(message, request)) { fail(); throw invalid(); }
      if (message.message_type === 'COOPERATIVE_CLOSE_FAILED') { fail(); return false; }
      if (message.message_type !== 'COOPERATIVE_SEAL') { fail(); throw invalid(); }
      // Consume capability before any await. Re-entry/duplicates cannot issue another ACK.
      state = 'SEALED_WAITING_ACK'; receipt = Object.freeze(pick(message, sealFields));
      try {
        await send(protocol.message('COOPERATIVE_SEAL_ACK', receipt));
        if (state !== 'SEALED_WAITING_ACK') throw invalid();
        state = 'CLOSED'; return true;
      } catch (error) { fail(); throw error; }
    },
    fail,
    snapshot: () => Object.freeze({ state }),
  });
}

function createChildBridge({ protocol, send, scope, closeAdmission, drain, onClosed, onFailure }) {
  let state = 'RUNNING', request, receipt;
  function fail() { state = 'FAILED'; }
  async function close(message) {
    if (state !== 'RUNNING' || message.message_type !== 'COOPERATIVE_CLOSE_REQUEST') { fail(); throw invalid(); }
    request = Object.freeze(pick(message, requestFields)); state = 'CLOSE_REQUESTED';
    try {
      // Fence synchronously; the control plane stays alive across the real drain.
      const closing = closeAdmission(); state = 'DRAINING';
      await closing;
      const result = await drain();
      if (state !== 'DRAINING' || result?.drained !== true) throw invalid();
      const seal = scope.sealClosedScope();
      if (!scope.ownsSeal(seal)) throw invalid();
      // sealClosedScope rechecks all counters, required capabilities and late blockers.
      // Identity/profile/version are also checked against the authenticated envelope.
      const response = protocol.message('COOPERATIVE_SEAL', { ...request,
        seal_id: seal.seal_id, closure_generation: seal.closure_generation });
      if (seal.executor_id !== response.executor_id || seal.boot_id !== response.boot_id ||
          seal.runtime_profile !== response.runtime_profile || seal.protocol_version !== response.protocol_version) throw invalid();
      receipt = Object.freeze(pick(response, sealFields)); state = 'SEALED_WAITING_ACK';
      await send(response);
    } catch {
      const notify = state === 'DRAINING' || state === 'CLOSE_REQUESTED';
      fail();
      if (notify) {
        try { await send(protocol.message('COOPERATIVE_CLOSE_FAILED', { ...request, failure_code: 'NOT_CERTIFIABLE' })); } catch {}
      }
      onFailure();
    }
  }
  return Object.freeze({
    close,
    receive(message) {
      if (state !== 'SEALED_WAITING_ACK' || message.message_type !== 'COOPERATIVE_SEAL_ACK' || !matches(message, receipt)) {
        fail(); throw invalid();
      }
      state = 'CLOSED'; onClosed();
    },
    fail,
    snapshot: () => Object.freeze({ state }),
  });
}
module.exports = { createParentBridge, createChildBridge };
