const p = require('./sql031Payloads');

async function readExecutionSubjects(tx, binding, input) {
  p.object(input, ['executor_id', 'boot_id', 'limit'], ['after_execution_id']);
  const ex = p.executor({ executor_id: input.executor_id, boot_id: input.boot_id });
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw p.invalid();
  const after = Object.hasOwn(input, 'after_execution_id') ? p.uuid(input.after_execution_id) : null;
  const s = '"' + tx.schema + '"';
  const birth = await tx.query(`SELECT b.executor_id FROM ${s}.evolution_executor_birth_bindings b
   JOIN ${s}.evolution_supervisors s USING(supervisor_id) JOIN ${s}.evolution_executor_gates g USING(executor_id,boot_id)
   WHERE b.executor_id=$1 AND b.boot_id=$2 AND b.supervisor_id=$3 AND b.supervisor_boot_id=$4
   AND s.issuer_role=session_user AND g.state='CLOSED'`, [ex.executor_id, ex.boot_id, binding.supervisor_id, binding.supervisor_boot_id]);
  if (birth.rows.length !== 1) throw p.invalid();
  const { rows } = await tx.query(`SELECT e.execution_id,e.executor_id,x.boot_id,$3::text AS source_schema,
   e.assinatura_id::text,e.instance_name,e.operation_kind,e.delivery_id::text,e.claim_token,
   'sha256:'||encode(sha256(convert_to('studiofy.operation-token.v1:'||e.operation_token::text,'UTF8')),'hex') AS operation_token_fingerprint
   FROM ${s}.evolution_operation_executions e JOIN ${s}.evolution_executors x USING(executor_id)
   JOIN ${s}.evolution_execution_authorizations a USING(execution_id)
   WHERE e.executor_id=$1 AND x.boot_id=$2 AND ($4::uuid IS NULL OR e.execution_id>$4::uuid)
   ORDER BY e.execution_id LIMIT $5`, [ex.executor_id, ex.boot_id, tx.schema, after, input.limit]);
  return Object.freeze(rows.map(row => {
    const subject = p.subject(row);
    if (subject.executor_id !== ex.executor_id || subject.boot_id !== ex.boot_id || subject.source_schema !== tx.schema) throw p.invalid();
    return subject;
  }));
}
module.exports = { readExecutionSubjects };
