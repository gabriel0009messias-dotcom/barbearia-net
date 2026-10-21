# Stage 3B.1: dormant SQL stop-proof foundation

Base: `3c6f82af7618c98bf46081b01aaa9b95318f860c`.

This change provides schema, controlled SQL APIs and guards. It does not implement
a supervisor, IPC, a cooperative seal, process observation, historical callbacks,
container-death proof, reconciliation or recovery. `npm start`, Render settings
and the 3A drain remain unchanged. All proofs in the tests are synthetic fixtures.
Applying this migration to production is not part of this implementation task.

## Implemented now

Migration 031 runs inside the existing migrator transaction with a local 2-second
DDL lock timeout. Migrations 001-030 are unchanged. There is no INSERT SELECT
backfill and no automatically enrolled executor.

Six new tables provide immutable supervisor identities, immutable birth bindings,
monotonic executor gates, append-only closure events, append-only per-execution
proofs and an immutable STOPPED projection. Ordinary UPDATE, DELETE and TRUNCATE
of evidence fail in PostgreSQL. INSERT guards additionally check cross-record
identity, original-derived fingerprints and projection references. PostgreSQL
supplies `recorded_at`; `observed_at` is an issuer observation, not a lease clock.

Enrollment is explicit: `studiofy_register_supervisor(jsonb)` followed by
`studiofy_register_executor_birth(jsonb)`. Birth registration atomically creates
a NEW 029 executor identity, binding and BOOTSTRAPPING gate. It rejects existing
executor/boot identities. The birth INSERT guard also requires that the 029 row
was created in the same transaction and has no executions. PID alone is never
accepted as a binding. The profile supported by version 1 is
`evolution-single-process-v1`; other profiles and protocol versions fail closed.

`studiofy_advance_executor_gate(executor, boot, supervisor, state)` permits OPEN
and DRAINING, without regression. CLOSED requires an accepted closure event.
`studiofy_accept_executor_closure(jsonb)` accepts only the two 3B modalities and
requires the complete, allowlisted evidence shape. Cooperative acceptance requires
DRAINING and all relevant counters zero; exit evidence requires the exact spawn,
exit observation, descendants closed and SQL fenced. These are assertions from a
TRUSTED future issuer: PostgreSQL cannot inspect JavaScript tasks or OS processes.
A zero snapshot, expired lease, timeout, abort or IPC disconnect is not evidence.
No function in this change observes or automatically emits those facts.

`studiofy_accept_execution_stop(jsonb)` verifies the execution, executor, boot,
schema, tenant, instance, operation kind, delivery, claim, supervisor and event.
It derives the token fingerprint from the immutable original UUID using SHA-256
with the domain prefix `studiofy.operation-token.v1:`; the proof ledger stores no
raw operation token. Evidence hash refers to the immutable event payload. Both
hashes use the explicitly versioned `pg-jsonb-v1` representation (PostgreSQL jsonb
text encoded as UTF-8). The UUID token has high entropy; this is not a password hash.

Idempotency is scoped to supervisor + key, separately for events and proofs.
Retries must preserve the complete request including its UUIDs, observation and
key. jsonb ignores object key order and whitespace; changing a value, UUID or
timestamp representation changes the canonical request and is a conflict.
Unique event/type/boot and event/execution constraints prevent incompatible
duplicates. Cooperative and exit evidence may both be recorded; the first valid
STOPPED projection is retained rather than replaced.

Proof acceptance inserts evidence/projection and revokes ACTIVE authorization to
UNKNOWN atomically. It does not write `evolution_operation_executions`, delivery,
owner, token, outbox, receipts or reconciliation tables. UNKNOWN authorization
alone never implies STOPPED. `evolution_execution_lifecycle_status` projects
STOPPED from the proof-linked stop row, otherwise ACTIVE/UNKNOWN from authority
and gate availability (a closed gate awaiting per-execution proof is UNKNOWN).
The original 029 state remains immutable initial evidence.

## Lock protocol

Normal order is business rows (source, owner, delivery, correlation when needed),
then executor gate, then execution authorization, then proof/projection.

The gate combines a schema/executor transaction advisory ticket and a row lock.
Normal operations acquire a shared ticket and FOR SHARE on the gate. Transitions
and acceptance acquire an exclusive ticket and FOR UPDATE. All locks end with the
transaction. The ticket is synchronization, never proof of death; hash collision
can only over-serialize unrelated executors, not identify or certify them.

Authorization UPDATE locks its row before a row trigger executes. Consequently,
the authorization trigger MUST NOT acquire or wait for a gate there. It verifies
that the transaction already holds a gate ticket and rejects a missing ticket.
The normal `checkAuthorization` caller now takes the gate before its existing
FOR UPDATE. Bare SQL renewal of an enrolled execution must do the same. A ticket
does not replace gate/state validation or authorize an effect by itself.

Registration's new BEFORE trigger sorts after the existing 029 business checks.
Delivery's BEFORE trigger sorts before the 030 authorization frontier. Existing
finalization prelocks its delivery/correlation via
`studiofy_execution_lock_finalization(token)` before gate/auth. Correlation and
owner-release guards fence the corresponding enrolled paths. Finalization may
finish in DRAINING, while admission, boundary and renewal require OPEN. CLOSED
denies ordinary work, including the interval before per-execution projection.

Acceptance never acquires owner/delivery locks. An earlier guarded SQL mutation
holds its shared gate until COMMIT/ROLLBACK, so closure waits for it. A mutation
that reaches the gate after closure is rejected. Proof acceptance takes gate,
authorization, ledger/projection, in that order, using a dedicated transaction
without earlier authorization/business locks. Large boots can persist closure
first and project execution proofs in bounded, idempotent transactions.

No PostgreSQL transaction spans external HTTP. The empty-scope versus new-effect
race additionally requires the trusted irreversible local seal in future 3B.2;
3B.1 alone does not claim to establish that runtime condition.

## Compatibility and failures

Existing/current executors without an explicit birth and gate remain in 3A/030
mode. New helpers return without gating them; no identities or evidence are
fabricated. This also permits old and new code to overlap during a future deploy.
An unbound boot can never acquire a retroactive birth via the enrollment API.
Stopped executions cannot acquire/renew authority or cross the durable frontier;
late internal correlation is rejected. An independent historical FACT flow is
reserved for a later substage and is not implemented here.

PostgreSQL unavailable means no durable acceptance. There is no file/memory
fallback. Unknown COMMIT must be resolved by read-back/retry of the same key and
request. The tests simulate an acknowledgement loss after an actual COMMIT; they
do not claim to inject every network/server crash window. If supervisor and
executor die without a persisted proof, the result remains UNKNOWN (future 3C).

Legacy delivery 37 has no new identity/binding/proof. Its isolated test equivalent
is preserved with uncertain status, attempts, token, ownership and receipts.
No production connection or barbearia-1 action is part of this work.

## Permissions implemented now

All new table privileges and SQL API EXECUTE are revoked from PUBLIC and from
non-owner grants inherited through default ACLs. Privileged
functions have fixed `search_path=pg_catalog` and schema-qualified objects.
Allowlisted JSON inputs reject unknown fields; API tokens, headers, messages,
phones and credentials are not proof payload fields. Supervisor registration
binds the issuer to `session_user`; future separate login roles cannot adopt
another issuer's supervisor through these APIs. `SECURITY DEFINER` does not turn
`current_user` into an authenticated original caller, hence `session_user`.

The migration owner can still call these APIs and administer its tables. The
current deployment uses a shared database credential and automatic migrations.
Revoking PUBLIC is NOT a claim that its executor is isolated from the owner.
There is no supervisor identity enrollment in the normal runtime in 3B.1.

## Requires future operational activation

Activation blocker: **`3B_PERMISSION_SEPARATION_REQUIRED`**.

Before enabling 3B.2 or 3B.3 in production, there must be real, adequate separation
between migration privilege, proof issuer privilege and normal executor privilege.
Do not declare complete operational security while they share a privileged
credential. This blocks activation, not the dormant 3B.1 foundation commit.

Before a real issuer is enabled, separate the migration owner, proof issuer login
and ordinary executor credential. The executor must not own the schema, inherit
the issuer/owner role, execute enrollment/transition/acceptance APIs, or recover
issuer credentials from environment or `.env`. Run migrations with the migration
credential, rather than giving the child that credential. Grant the executor
only its business privileges and the gate/finalization helper EXECUTE it needs.
Grant the dedicated issuer only the enrollment/transition/acceptance APIs it
needs; do not grant direct evidence table writes. Any pool/proxy must preserve
the distinct authenticated login identities. Audit existing/default ACLs during
that activation. No roles, credentials, Render variables or startup commands are
provisioned for deployment by this change.

The PostgreSQL tests require an exclusive test database and a test login able to
create schemas and test roles. ACL tests create NOLOGIN roles inside transactions
that are rolled back; they do not provision deployment credentials or roles.

Future 3B.2 must implement the irreversible seal and full task/SQL accounting.
Future 3B.3 must observe spawn/handshake/exit and enforce the certified descendant
profile. Proof APIs must remain unexposed to HTTP/customer input. No proof may
trigger retry, abandoned_unknown, delivery reconciliation or reservation release.
