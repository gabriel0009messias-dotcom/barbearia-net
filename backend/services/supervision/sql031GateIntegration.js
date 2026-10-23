const { randomUUID } = require('node:crypto');
const p = require('./sql031Payloads');
const { createSql031Authority } = require('./sql031Authority');

// Trusted, local-test composition only. Never import this from startup or child IPC.
function createDormantSql031Gate(options) {
  p.object(options, ['transactionRunner', 'supervisor', 'birth', 'requiredCapabilities']);
  const supervisor = p.supervisor(options.supervisor);
  p.birth(options.birth);
  const birth = Object.freeze({ ...options.birth });
  if (birth.supervisor_id !== supervisor.supervisor_id || birth.supervisor_boot_id !== supervisor.supervisor_boot_id ||
      !Array.isArray(options.requiredCapabilities) || !options.requiredCapabilities.length ||
      options.requiredCapabilities.some(k => typeof k !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(k))) throw p.invalid();
  // 2A enforces the authentic injected runner, local-only DB and distinct LOGINs.
  const authority = createSql031Authority({ transactionRunner: options.transactionRunner,
    issuerIdentity: { supervisor_id: supervisor.supervisor_id, supervisor_boot_id: supervisor.supervisor_boot_id } });
  // Lazy imports keep module loading free of process-local scope installation.
  if (require('./context').current()) throw p.invalid();
  const { createExecutionScope } = require('../executionScope');
  const { createCapabilityCoordinator } = require('../executionCapabilities');
  const scope = createExecutionScope({ certifiable: true, runtimeProfile: birth.runtime_profile });
  scope.setExecutor({ executorId: birth.executor_id, bootId: birth.boot_id });
  scope.certifyProfile({ requiredCapabilities: [...options.requiredCapabilities] });
  const coordinator = createCapabilityCoordinator(scope);
  const identity = Object.freeze({ executor_id: birth.executor_id, boot_id: birth.boot_id });
  let state = 'NEW', gate = null, code = null, confirmedClosure, stopProjection;
  const failure = () => Object.freeze({ outcome: state === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN_FAILURE', code: code || 'SQL031_GATE_SEQUENCE' });
  function fence(next, reason) {
    state = next; code = reason; scope.beginDrain();
    scope.blockCertification(reason);
    if (next === 'UNKNOWN') gate = 'UNKNOWN';
    return failure();
  }
  async function persist(operation) {
    let result;
    try { result = await operation(); }
    catch { return fence('UNKNOWN', 'SQL031_GATE_UNRESOLVED'); }
    if (result?.outcome === 'CONFIRMED') return result;
    return fence(result?.outcome === 'KNOWN_FAILURE' ? 'FAILED' : 'UNKNOWN', result?.code || 'SQL031_GATE_UNRESOLVED');
  }
  function accountingClear() {
    const a = authority.snapshot();
    return a.inFlight === false && a.pendingSql === 0 && a.unresolvedSql === 0 && a.blocked === false &&
      a.attempts === a.confirmed && a.knownFailures === 0 && a.blockers.length === 0;
  }
  function accountingFailure() {
    const a = authority.snapshot();
    return fence(a.unresolvedSql > 0 || a.blocked ? 'UNKNOWN' : 'FAILED', 'SQL031_GATE_ACCOUNTING');
  }
  const admissionClosed = () => Object.assign(Error('Persistent gate admission is closed.'), { code: 'INSTANCE_ADMISSION_CLOSED' });
  function admit(kind, work) {
    if (state !== 'OPEN' || !accountingClear()) return Promise.reject(admissionClosed());
    return scope.admitRoot(kind, work, { canAdmit: () => state === 'OPEN' && accountingClear() });
  }
  // Only this capability is handed to trusted executor work. No SQL, identities,
  // enrollment, OPEN, closure, STOPPED or reservation controls cross this boundary.
  const executor = Object.freeze({
    admit,
    follow: (kind, work) => scope.follow(kind, work),
    enqueue: (kind, work) => scope.enqueue(kind, work),
    obligation: kind => scope.obligation(kind),
    registerCapability(name, stop) {
      if (!['NEW', 'BORN', 'OPEN'].includes(state)) throw admissionClosed();
      return coordinator.register(name, stop);
    },
    blockCertification: reason => scope.blockCertification(reason),
    snapshot: scope.snapshot,
  });
  return Object.freeze({
    executor,
    async bootstrap(...args) {
      if (args.length || state !== 'NEW') return failure();
      state = 'ENROLLING';
      if (!accountingClear()) return accountingFailure();
      let result = await persist(() => authority.registerSupervisor(supervisor));
      if (result.outcome !== 'CONFIRMED') return result;
      result = await persist(() => authority.registerExecutorBirth(birth));
      if (result.outcome !== 'CONFIRMED') return result;
      gate = 'BOOTSTRAPPING'; state = 'BORN'; return result;
    },
    async open(...args) {
      if (args.length || state !== 'BORN') return failure();
      state = 'OPENING';
      if (!accountingClear()) return accountingFailure();
      const result = await persist(() => authority.openExecutorGate(identity));
      if (result.outcome !== 'CONFIRMED') return result;
      gate = 'OPEN'; state = 'OPEN'; return result;
    },
    async close(options = {}) {
      // No caller evidence/identity/receipt is accepted, including child payloads.
      p.object(options, [], ['timeoutMs']);
      const timeoutMs = options.timeoutMs ?? 1000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) throw p.invalid();
      if (state !== 'OPEN') return failure();
      state = 'DRAINING'; scope.beginDrain(); // Fence synchronously, before SQL/await.
      if (!accountingClear()) return accountingFailure();
      let result = await persist(() => authority.beginExecutorDraining(identity));
      if (result.outcome !== 'CONFIRMED') return result;
      gate = 'DRAINING';
      try {
        const before = scope.snapshot();
        if (before.certificationBlocked.length) return fence('FAILED', 'SQL031_SCOPE_NOT_CERTIFIABLE');
        const drained = await coordinator.drain({ timeoutMs });
        if (!accountingClear()) return accountingFailure();
        if (drained.drained !== true) return fence('FAILED', 'SQL031_DRAIN_INCOMPLETE');
        // The existing seal implementation rechecks descendants, capabilities,
        // callbacks, correlations, SQL obligations, unknowns and profile coverage.
        const seal = scope.sealClosedScope(), snapshot = scope.snapshot();
        if (!scope.ownsSeal(seal) || snapshot.state !== 'CLOSED' || snapshot.activeCount !== 0 ||
            snapshot.capabilities.length || snapshot.obligations.length || snapshot.certificationBlocked.length ||
            seal.executor_id !== identity.executor_id || seal.boot_id !== identity.boot_id ||
            seal.protocol_version !== 1 || seal.runtime_profile !== birth.runtime_profile ||
            seal.closure_generation < 1 || seal.counters.capabilities !== 0) throw p.invalid();
        // Project the authentic seal, never synthesize zero counters from exit/IPC.
        const evidence = p.closure({ closure_event_id: randomUUID(), proof_type: 'COOPERATIVE_SCOPE_CLOSED',
          protocol_version: 1, ...identity, supervisor_id: supervisor.supervisor_id, supervisor_boot_id: supervisor.supervisor_boot_id,
          origin: 'supervisor-ipc-v1', evidence_canonicalization_version: 'pg-jsonb-v1',
          observed_at: new Date().toISOString(), idempotency_key: randomUUID(), evidence: {
            seal_id: seal.seal_id, admission_closed: seal.admission_closed, scope_closed: seal.scope_closed,
            active_tasks: seal.counters.active_tasks, active_descendants: seal.counters.active_descendants,
            active_transports: seal.counters.active_transports, pending_callbacks: seal.counters.pending_callbacks,
            pending_correlations: seal.counters.pending_correlations, pending_sql: seal.counters.pending_sql,
            unresolved_sql: seal.counters.unresolved_sql, runtime_profile: seal.runtime_profile } });
        state = 'SEALING';
        result = await persist(() => authority.acceptCooperativeClosure(evidence));
        if (result.outcome !== 'CONFIRMED') return result;
        confirmedClosure = result.value;
        gate = 'CLOSED'; state = 'CLOSED'; return result;
      } catch { return fence('FAILED', 'SQL031_SCOPE_NOT_CERTIFIABLE'); }
    },
    createStopProjection(...args) {
      if (args.length) throw p.invalid();
      if (stopProjection) return stopProjection; // Never construct a fresh session after UNKNOWN/failure.
      if (state !== 'CLOSED' || gate !== 'CLOSED' || !confirmedClosure || !accountingClear()) throw p.invalid();
      const receipt = confirmedClosure;
      const { createDormantSql031StopProjection } = require('./sql031StopIntegration');
      stopProjection = createDormantSql031StopProjection({ authority, closureReceipt: receipt,
        binding: { ...identity, supervisor_id: supervisor.supervisor_id, supervisor_boot_id: supervisor.supervisor_boot_id },
        isClosed: () => state === 'CLOSED' && gate === 'CLOSED' && confirmedClosure === receipt });
      return stopProjection;
    },
    snapshot: () => Object.freeze({ state, gate, admissionAllowed: state === 'OPEN' && accountingClear() && scope.isOpen(),
      accounting: authority.snapshot(), scope: scope.snapshot(), proof: false, stopped: false,
      persistentEmissionEnabled: false, activationBlocker: '3B_PERMISSION_SEPARATION_REQUIRED' }),
  });
}
module.exports = { createDormantSql031Gate };
