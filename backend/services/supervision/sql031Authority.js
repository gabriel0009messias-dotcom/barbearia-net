const p = require('./sql031Payloads');
const { isControlSqlRunner } = require('./sql031Transactions');
const { readExecutionSubjects } = require('./sql031Subjects');

// Explicit isolated-test composition only. No runtime singleton or bridge integration.
function createSql031Authority(options) {
  p.object(options, ['transactionRunner', 'issuerIdentity']);
  const runner = options.transactionRunner;
  if (!isControlSqlRunner(runner)) throw p.invalid();
  p.object(options.issuerIdentity, ['supervisor_id', 'supervisor_boot_id']);
  const binding = Object.freeze({ supervisor_id: p.uuid(options.issuerIdentity.supervisor_id), supervisor_boot_id: p.uuid(options.issuerIdentity.supervisor_boot_id) });
  const subjects = new WeakSet(), closures = new WeakSet(), s = '"' + runner.context.schema + '"';
  function bound(payload) {
    if (payload.supervisor_id !== binding.supervisor_id || payload.supervisor_boot_id !== binding.supervisor_boot_id) throw p.invalid();
    return payload;
  }
  async function gate(input, state) {
    const ex = p.executor(input);
    return runner.run(async tx => {
      const r = await tx.query(`SELECT ${s}.studiofy_advance_executor_gate($1,$2,$3,$4) AS state`,
        [ex.executor_id, ex.boot_id, binding.supervisor_id, state]);
      if (r.rows.length !== 1 || r.rows[0].state !== state) throw p.invalid();
      return Object.freeze({ executor_id: ex.executor_id, boot_id: ex.boot_id, state });
    });
  }
  return Object.freeze({
    snapshot: runner.snapshot,
    registerSupervisor(input) {
      const payload = bound(p.supervisor(input));
      return runner.run(async tx => {
        const r = await tx.query(`SELECT ${s}.studiofy_register_supervisor($1::jsonb) AS id`, [JSON.stringify(payload)]);
        if (r.rows.length !== 1 || r.rows[0].id !== payload.supervisor_id) throw p.invalid();
        return Object.freeze({ supervisor_id: payload.supervisor_id, supervisor_boot_id: payload.supervisor_boot_id });
      });
    },
    registerExecutorBirth(input) {
      const payload = bound(p.birth(input));
      return runner.run(async tx => {
        const r = await tx.query(`SELECT ${s}.studiofy_register_executor_birth($1::jsonb) AS id`, [JSON.stringify(payload)]);
        if (r.rows.length !== 1 || r.rows[0].id !== payload.executor_id) throw p.invalid();
        return Object.freeze({ executor_id: payload.executor_id, boot_id: payload.boot_id, state: 'BOOTSTRAPPING' });
      });
    },
    openExecutorGate: input => gate(input, 'OPEN'),
    beginExecutorDraining: input => gate(input, 'DRAINING'),
    async acceptCooperativeClosure(input) {
      const payload = bound(p.closure(input));
      const result = await runner.run(async tx => {
        const accepted = await tx.query(`SELECT ${s}.studiofy_accept_executor_closure($1::jsonb) AS id`, [JSON.stringify(payload)]);
        if (accepted.rows.length !== 1 || accepted.rows[0].id !== payload.closure_event_id) throw p.invalid();
        const r = await tx.query(`SELECT closure_event_id,proof_type,protocol_version,executor_id,boot_id,supervisor_id,
         supervisor_boot_id,evidence_canonicalization_version,evidence_hash FROM ${s}.evolution_executor_closure_events WHERE closure_event_id=$1`, [payload.closure_event_id]);
        if (r.rows.length !== 1) throw p.invalid();
        const receipt = bound(p.closureReceipt(r.rows[0]));
        if (receipt.executor_id !== payload.executor_id || receipt.boot_id !== payload.boot_id) throw p.invalid();
        return receipt;
      });
      if (result.outcome === 'CONFIRMED') closures.add(result.value);
      return result;
    },
    async listExecutionSubjects(input) {
      // Validate before acquiring an injected connection; never select by delivery.
      p.object(input, ['executor_id', 'boot_id', 'limit'], ['after_execution_id']);
      const ex = p.executor({ executor_id: input.executor_id, boot_id: input.boot_id });
      const request = { executor_id: ex.executor_id, boot_id: ex.boot_id, limit: input.limit };
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw p.invalid();
      if (Object.hasOwn(input, 'after_execution_id')) request.after_execution_id = p.uuid(input.after_execution_id);
      Object.freeze(request);
      const result = await runner.run(tx => readExecutionSubjects(tx, binding, request), { readOnly: true });
      if (result.outcome === 'CONFIRMED') for (const subject of result.value) subjects.add(subject);
      return result;
    },
    acceptExecutionStop(input) {
      p.object(input, ['subject', 'closureReceipt', 'proof_id', 'idempotency_key']);
      if (!subjects.has(input.subject) || !closures.has(input.closureReceipt)) throw p.invalid();
      const payload = bound(p.proof({ proof_id: input.proof_id, idempotency_key: input.idempotency_key }, input.subject, input.closureReceipt));
      return runner.run(async tx => {
        const r = await tx.query(`SELECT ${s}.studiofy_accept_execution_stop($1::jsonb) AS id`, [JSON.stringify(payload)]);
        if (r.rows.length !== 1 || r.rows[0].id !== payload.proof_id) throw p.invalid();
        return Object.freeze({ proof_id: payload.proof_id, execution_id: payload.execution_id });
      });
    },
  });
}
module.exports = { createSql031Authority };
