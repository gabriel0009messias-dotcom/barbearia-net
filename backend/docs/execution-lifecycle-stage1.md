# Execution lifecycle Stage 1: durable reservation provenance

This checkout starts at published commit aca8529. Earlier experimental incident
37 routes, certificates and migrations from other local checkouts are excluded.
No production configuration or data is accessed by this implementation task.

## Scope and identity

One executor_id and boot_id are generated per Node process, stored on a frozen
process-global identity so creating service objects or reloading modules cannot
accidentally create another executor. Restarted processes generate new UUIDs;
PID reuse and redeploying the same commit cannot reuse this identity. started_at
uses Node's performance.timeOrigin, not the time of the first delivery. The
database separately records registration time with its own clock.

Optional metadata is captured from explicit RENDER_SERVICE_ID, RENDER_DEPLOY_ID,
RENDER_INSTANCE_ID and RENDER_GIT_COMMIT values when present and well formed.
Missing values remain NULL. A commit is a revision, never a fabricated deployment
identity. No secret, phone number, message body or full environment is stored.
Platform metadata remains an observation, not a supervisor death attestation.

Every successful new reservation made through the principal ownership operation
creates a distinct execution_id and operation_token binding. Different concurrent
operations in the SAME Node process correctly share executor_id/boot_id, but not
execution_id or token. Different processes have different executor/boot IDs.

## Atomic acquisition

The existing lock order is preserved: account -> canonical owner -> delivery
when applicable. The existing onReserved hook validates the sending claim and
binds its token. The same transaction then registers the executor and execution.
Both records commit together with reservation and delivery token, before the
existing transport execution guard and boundary. No transaction spans HTTP.

Delivery registrations include kind, ID, tenant, exact Evolution instance,
claim and token. A database trigger revalidates the live reserved owner and the
original sending delivery with no transport boundary; reminder instance identity
comes from its persisted snapshot. Generic instance operations are explicitly
typed and have no invented delivery/claim. Their callback context also receives
the execution, executor and boot IDs.

Failed registration rolls back reservation and binding; existing safe pre-request
recovery remains responsible for unstarted claims. A lost COMMIT acknowledgment
never starts the callback, even if provenance and reservation already committed.
Current non-idempotent writes do not gain retry loops.

## Deliberately inactive lifecycle transitions

Only ACTIVE initial records are registered in this stage. ACTIVE means started
and not finalized by this stage; it is NOT proof that a process is still alive.
Even successful completed operations retain their initial evidence. Existing
successful reservation release and delivery finalization remain unchanged.

STOPPED/UNKNOWN state vocabulary and nullable heartbeat_at, lease_until and
stopped_at fields reserve space for later reviewed stages. Stage 1 does not
populate these fields, update states, run heartbeats, expire reservations or
infer STOPPED from timeout, connection loss, callback completion or process exit.
The tables reject identity updates, deletes and truncation. Lifecycle field
transitions are also rejected for now; introducing them requires a later change
to the guards, evidence requirements and tests. There is no new recovery,
administrative route, reconciliation, outbox ordering or transport endpoint.

The existing delivery guard, durable boundary, transport callback, outcome
classification, normal release, explicit reconciler and scheduling are unchanged.
An uncertain delivery is never made pending by this feature. Legacy records,
including real delivery 37, are not scanned, backfilled or registered. A stale
dispatch with uncertain status fails the existing claim validation before any
execution evidence is created.

## Migration, retention and rollout compatibility

029_execution_lifecycle_foundation.sql creates only two new tables and their
constraints/functions/triggers/indexes, with lock_timeout=2s. No ALTER, backfill,
index build or FK validation is performed on existing delivery, ownership or
tenant tables. The FK is between the new execution and executor tables only.
Audit identity intentionally survives business-object deletion; no message or
customer payload is duplicated into these audit tables. Audit retention needs
an explicit policy before any future pruning feature.

The new execution INSERT guard checks existing records under row locks during
ordinary operation. Those owner/delivery locks are already held in the same
transaction; it does not introduce reversed lock ordering. Two short registration
queries are added inside acquisition, without another pool connection. The
executor upsert can briefly serialize first-time concurrent reservations from
the same process; no network work occurs while that transaction is open.

The migration is transactional and serialized by the existing migration runner.
Rollback of a failed migration leaves no partial structures. Rolling application
code back leaves additive tables intact; do not delete evidence as a rollback.

Old binaries tolerate the additive schema but do not write provenance. During a
mixed rollout their reservations remain unidentified; coverage applies only to
the new binary and becomes complete for new reservations after old binaries have
retired. Never backfill those gaps with the currently running process identity.
Starting the new binary without its migration fails closed at reservation
registration. The existing app startup already waits for migrations.

This foundation is not sufficient to recover an orphan. No production deployment
or activation is authorized by these notes. Future stages must separately prove
executor termination, record release evidence and resolve unknown dispositions.

## Local verification

Tests use Node 20.20.1 and disposable schemas in the audited local PostgreSQL
cluster. The dedicated runner removes operational credentials, blocks external
network requests and verifies the cluster data_directory before running tests.

execution-lifecycle.test.js checks atomic provenance before transport, correct
scope, immutable identity, concurrent operations, independent OS processes and
restart, failed INSERT rollback, lost COMMIT ACK, timeout/late callback without
STOPPED or release, uncertain without retry and an unchanged synthetic legacy
delivery 37. The synthetic legacy tenant/instance are unrelated to production.

execution-lifecycle-migration.test.js checks actual upgrade from published 028,
rollback/failure atomicity, concurrent migrators, unchanged legacy rows/columns
and rejection of retroactive registration of an uncertain delivery. Existing
tests cover reminders, booking confirmation, conversation, webhook, outbox,
Agenda and transport/ownership behavior. No test connects to production.
