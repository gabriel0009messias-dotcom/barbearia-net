const { randomUUID } = require('node:crypto');
const p = require('./sql031Payloads');

// Internal trusted-parent constructor. Public callers use gate.createStopProjection().
// Receipt/subject provenance remains enforced by the original 2A authority WeakSets.
function createDormantSql031StopProjection(options) {
  p.object(options, ['authority', 'closureReceipt', 'binding', 'isClosed']);
  const { authority, closureReceipt, isClosed } = options;
  p.object(options.binding, ['executor_id', 'boot_id', 'supervisor_id', 'supervisor_boot_id']);
  const binding = Object.freeze(Object.fromEntries(Object.entries(options.binding).map(([key, value]) => [key, p.uuid(value)])));
  const receipt = p.closureReceipt(closureReceipt); // Validate, never replace the original object.
  if (!Object.isFrozen(authority) || !Object.isFrozen(closureReceipt) || typeof isClosed !== 'function' || !isClosed() ||
      !['snapshot', 'listExecutionSubjects', 'acceptExecutionStop'].every(k => typeof authority[k] === 'function') ||
      Object.keys(binding).some(k => binding[k] !== receipt[k])) throw p.invalid();
  const limit = 100, confirmed = [];
  let state = 'READY', cursor = null, pending, terminalResult, attempt = null;
  function coherent() {
    const a = authority.snapshot();
    return !a.inFlight && a.pendingSql === 0 && a.unresolvedSql === 0 && !a.blocked &&
      a.attempts === a.confirmed && a.knownFailures === 0 && a.blockers.length === 0;
  }
  function terminate(outcome, code, prefix) {
    state = outcome === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
    terminalResult = Object.freeze({ outcome, code, value: Object.freeze({ confirmed: Object.freeze([...prefix]),
      cursor, complete: false, attempt }) });
    return terminalResult;
  }
  function accountingFailure(prefix) {
    const a = authority.snapshot();
    return terminate(a.blocked || a.unresolvedSql > 0 ? 'UNKNOWN' : 'KNOWN_FAILURE', 'SQL031_STOP_ACCOUNTING', prefix);
  }
  async function page() {
    const prefix = [];
    try {
      if (!isClosed()) return terminate('KNOWN_FAILURE', 'SQL031_STOP_NOT_CLOSED', prefix);
      if (!coherent()) return accountingFailure(prefix);
      const request = { executor_id: binding.executor_id, boot_id: binding.boot_id, limit };
      if (cursor !== null) request.after_execution_id = cursor;
      const selected = await authority.listExecutionSubjects(request);
      if (selected.outcome !== 'CONFIRMED') return terminate(selected.outcome === 'KNOWN_FAILURE' ? 'KNOWN_FAILURE' : 'UNKNOWN', selected.code, prefix);
      if (!Array.isArray(selected.value) || selected.value.length > limit) throw p.invalid();
      let previous = cursor;
      // Validate the entire page before issuing its first individual proof.
      for (const subject of selected.value) {
        const row = p.subject(subject);
        if (row.executor_id !== binding.executor_id || row.boot_id !== binding.boot_id ||
            (previous !== null && row.execution_id <= previous)) throw p.invalid();
        previous = row.execution_id;
      }
      for (const subject of selected.value) {
        if (!isClosed()) return terminate('KNOWN_FAILURE', 'SQL031_STOP_NOT_CLOSED', prefix);
        if (!coherent()) return accountingFailure(prefix);
        attempt = Object.freeze({ execution_id: subject.execution_id, proof_id: randomUUID(), idempotency_key: randomUUID() });
        const result = await authority.acceptExecutionStop({ subject, closureReceipt,
          proof_id: attempt.proof_id, idempotency_key: attempt.idempotency_key });
        if (result.outcome !== 'CONFIRMED') return terminate(result.outcome === 'KNOWN_FAILURE' ? 'KNOWN_FAILURE' : 'UNKNOWN', result.code, prefix);
        if (result.value?.execution_id !== subject.execution_id || result.value?.proof_id !== attempt.proof_id) {
          return terminate('UNKNOWN', 'SQL031_STOP_UNRESOLVED_RESULT', prefix);
        }
        // Move only after this execution's COMMIT acknowledgement, not page selection.
        const entry = Object.freeze({ execution_id: subject.execution_id, proof_id: attempt.proof_id });
        confirmed.push(entry); prefix.push(entry); cursor = subject.execution_id; attempt = null;
      }
      if (!coherent()) return accountingFailure(prefix);
      const complete = selected.value.length < limit;
      state = complete ? 'COMPLETE' : 'READY';
      const result = Object.freeze({ outcome: 'CONFIRMED', value: Object.freeze({ confirmed: Object.freeze(prefix), cursor, complete }) });
      if (complete) terminalResult = result;
      return result;
    } catch (error) {
      return terminate(error?.code === 'SQL031_INPUT_INVALID' ? 'KNOWN_FAILURE' : 'UNKNOWN',
        error?.code === 'SQL031_INPUT_INVALID' ? 'SQL031_STOP_INVALID_INPUT' : 'SQL031_STOP_UNRESOLVED', prefix);
    }
  }
  return Object.freeze({
    certifyNextPage(...args) {
      if (args.length) return Promise.reject(p.invalid());
      if (terminalResult) return Promise.resolve(terminalResult);
      if (pending) return pending;
      state = 'CERTIFYING';
      pending = Promise.resolve().then(page).finally(() => { pending = undefined; });
      return pending;
    },
    snapshot: () => Object.freeze({ state, cursor, confirmed: Object.freeze([...confirmed]), attempt,
      terminal: Boolean(terminalResult), persistentEmissionEnabled: false, activationBlocker: '3B_PERMISSION_SEPARATION_REQUIRED' }),
  });
}
module.exports = { createDormantSql031StopProjection };
