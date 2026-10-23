const { createHash } = require('node:crypto');

const PROFILE = 'evolution-single-process-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const META = /^[A-Za-z0-9_.-]{1,200}$/;
const KEY = /^[A-Za-z0-9_.:-]{1,160}$/;
const counters = ['active_tasks', 'active_descendants', 'active_transports', 'pending_callbacks', 'pending_correlations', 'pending_sql', 'unresolved_sql'];
function invalid() { return Object.assign(Error('Invalid SQL031 authority input.'), { code: 'SQL031_INPUT_INVALID' }); }
function object(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(k =>
    typeof k !== 'string' || ![...required, ...optional].includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value')) ||
    required.some(k => !Object.hasOwn(value, k) || value[k] === null || value[k] === undefined)) throw invalid();
  return value;
}
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) throw invalid(); return value; }
function hash(value) { if (typeof value !== 'string' || !HASH.test(value)) throw invalid(); return value; }
function bigint(value) {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value <= 0) throw invalid(); value = String(value); }
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw invalid();
  return value;
}
function text(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) throw invalid(); return value; }
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid();
  return value;
}
function version(value) { if (value !== 1) throw invalid(); return value; }
function profile(value) { if (value !== PROFILE) throw invalid(); return value; }
function pid(value) { if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw invalid(); return value; }
function optional(out, input, key, validate) {
  if (Object.hasOwn(input, key)) out[key] = input[key] === null ? null : validate(input[key]);
}
function supervisor(input) {
  object(input, ['supervisor_id', 'supervisor_boot_id', 'protocol_version', 'process_id', 'origin'], ['revision']);
  if (input.origin !== 'local-parent-v1') throw invalid();
  const out = { supervisor_id: uuid(input.supervisor_id), supervisor_boot_id: uuid(input.supervisor_boot_id),
    protocol_version: version(input.protocol_version), process_id: pid(input.process_id), origin: input.origin };
  optional(out, input, 'revision', v => text(v, META));
  return Object.freeze(out);
}
function birthNonce(input) {
  object(input, ['supervisor_id', 'supervisor_boot_id', 'spawn_id', 'executor_id', 'boot_id', 'session_challenge']);
  const parts = ['supervisor_id', 'supervisor_boot_id', 'spawn_id', 'executor_id', 'boot_id'].map(k => uuid(input[k]));
  parts.push(text(input.session_challenge, /^[a-f0-9]{64}$/));
  // Fixed ordered tuple, separate from both IPC HMAC and pg-jsonb-v1 evidence hashing.
  return 'sha256:' + createHash('sha256').update('studiofy.executor-birth.v1:' + JSON.stringify(parts), 'utf8').digest('hex');
}
function birth(input) {
  object(input, ['executor_id', 'boot_id', 'supervisor_id', 'supervisor_boot_id', 'spawn_id', 'observed_pid',
    'session_challenge', 'protocol_version', 'runtime_profile', 'observed_at', 'started_at'], ['instance_id', 'revision', 'service_id']);
  const out = { executor_id: uuid(input.executor_id), boot_id: uuid(input.boot_id), supervisor_id: uuid(input.supervisor_id),
    supervisor_boot_id: uuid(input.supervisor_boot_id), spawn_id: uuid(input.spawn_id), observed_pid: pid(input.observed_pid),
    nonce_fingerprint: birthNonce({ supervisor_id: input.supervisor_id, supervisor_boot_id: input.supervisor_boot_id,
      spawn_id: input.spawn_id, executor_id: input.executor_id, boot_id: input.boot_id, session_challenge: input.session_challenge }),
    protocol_version: version(input.protocol_version), runtime_profile: profile(input.runtime_profile),
    observed_at: timestamp(input.observed_at), started_at: timestamp(input.started_at) };
  for (const k of ['instance_id', 'revision', 'service_id']) optional(out, input, k, v => text(v, META));
  return Object.freeze(out);
}
function executor(input) {
  object(input, ['executor_id', 'boot_id']);
  return Object.freeze({ executor_id: uuid(input.executor_id), boot_id: uuid(input.boot_id) });
}
function evidence(input) {
  object(input, ['seal_id', 'admission_closed', 'scope_closed', ...counters, 'runtime_profile']);
  if (input.admission_closed !== true || input.scope_closed !== true || counters.some(k => input[k] !== 0)) throw invalid();
  return Object.freeze({ seal_id: uuid(input.seal_id), admission_closed: true, scope_closed: true,
    active_tasks: input.active_tasks, active_descendants: input.active_descendants, active_transports: input.active_transports,
    pending_callbacks: input.pending_callbacks, pending_correlations: input.pending_correlations,
    pending_sql: input.pending_sql, unresolved_sql: input.unresolved_sql, runtime_profile: profile(input.runtime_profile) });
}
function closure(input) {
  object(input, ['closure_event_id', 'proof_type', 'protocol_version', 'executor_id', 'boot_id', 'supervisor_id',
    'supervisor_boot_id', 'origin', 'evidence_canonicalization_version', 'evidence', 'observed_at', 'idempotency_key']);
  if (input.proof_type !== 'COOPERATIVE_SCOPE_CLOSED' || input.origin !== 'supervisor-ipc-v1' ||
      input.evidence_canonicalization_version !== 'pg-jsonb-v1') throw invalid();
  return Object.freeze({ closure_event_id: uuid(input.closure_event_id), proof_type: input.proof_type,
    protocol_version: version(input.protocol_version), executor_id: uuid(input.executor_id), boot_id: uuid(input.boot_id),
    supervisor_id: uuid(input.supervisor_id), supervisor_boot_id: uuid(input.supervisor_boot_id), origin: input.origin,
    evidence_canonicalization_version: input.evidence_canonicalization_version, evidence: evidence(input.evidence),
    observed_at: timestamp(input.observed_at), idempotency_key: text(input.idempotency_key, KEY) });
}
function subject(row) {
  object(row, ['execution_id', 'executor_id', 'boot_id', 'source_schema', 'assinatura_id', 'instance_name',
    'operation_kind', 'operation_token_fingerprint'], ['delivery_id', 'claim_token']);
  if (!Object.hasOwn(row, 'delivery_id') || !Object.hasOwn(row, 'claim_token')) throw invalid();
  const kind = row.operation_kind;
  if (!['instance_operation', 'whatsapp_messages', 'appointment_reminders'].includes(kind)) throw invalid();
  if (kind === 'instance_operation' ? row.delivery_id !== null || row.claim_token !== null : row.delivery_id === null || row.claim_token === null) throw invalid();
  return Object.freeze({ execution_id: uuid(row.execution_id), executor_id: uuid(row.executor_id), boot_id: uuid(row.boot_id),
    source_schema: text(row.source_schema, /^test_[a-f0-9]{32}$/), assinatura_id: bigint(row.assinatura_id),
    instance_name: text(row.instance_name, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), operation_kind: kind,
    delivery_id: row.delivery_id === null ? null : bigint(row.delivery_id), claim_token: row.claim_token === null ? null : uuid(row.claim_token),
    operation_token_fingerprint: hash(row.operation_token_fingerprint) });
}
function closureReceipt(row) {
  object(row, ['closure_event_id', 'proof_type', 'protocol_version', 'executor_id', 'boot_id', 'supervisor_id',
    'supervisor_boot_id', 'evidence_canonicalization_version', 'evidence_hash']);
  if (row.proof_type !== 'COOPERATIVE_SCOPE_CLOSED' || row.evidence_canonicalization_version !== 'pg-jsonb-v1') throw invalid();
  return Object.freeze({ closure_event_id: uuid(row.closure_event_id), proof_type: row.proof_type,
    protocol_version: version(row.protocol_version), executor_id: uuid(row.executor_id), boot_id: uuid(row.boot_id),
    supervisor_id: uuid(row.supervisor_id), supervisor_boot_id: uuid(row.supervisor_boot_id),
    evidence_canonicalization_version: row.evidence_canonicalization_version, evidence_hash: hash(row.evidence_hash) });
}
function proof(ids, derived, receipt) {
  object(ids, ['proof_id', 'idempotency_key']);
  const s = subject(derived), c = closureReceipt(receipt);
  if (s.executor_id !== c.executor_id || s.boot_id !== c.boot_id) throw invalid();
  return Object.freeze({ proof_id: uuid(ids.proof_id), idempotency_key: text(ids.idempotency_key, KEY),
    proof_type: c.proof_type, protocol_version: c.protocol_version, closure_event_id: c.closure_event_id,
    executor_id: s.executor_id, boot_id: s.boot_id, execution_id: s.execution_id, source_schema: s.source_schema,
    assinatura_id: s.assinatura_id, instance_name: s.instance_name, operation_kind: s.operation_kind,
    delivery_id: s.delivery_id, claim_token: s.claim_token, operation_token_fingerprint: s.operation_token_fingerprint,
    supervisor_id: c.supervisor_id, supervisor_boot_id: c.supervisor_boot_id,
    evidence_canonicalization_version: c.evidence_canonicalization_version, evidence_hash: c.evidence_hash });
}
module.exports = { invalid, object, uuid, hash, bigint, text, supervisor, birthNonce, birth, executor, closure, subject, closureReceipt, proof };
