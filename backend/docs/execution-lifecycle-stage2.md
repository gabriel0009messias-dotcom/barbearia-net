# Stage 2: executor authorization heartbeat and lease

Base: `86198601425b5fc01bbb7c21422df16d8cfde031`. Local implementation only.

## Separate evidence from permission

Migration 029 and its immutable executor/execution evidence remain unchanged.
Migration 030 adds `evolution_execution_authorizations`, keyed by the immutable
execution ID. The executor, boot, tenant, instance, kind, delivery, claim and token
remain bound through the original execution record. This sidecar holds mutable
**authorization state**, not transport outcome or evidence of executor death.

An AFTER INSERT trigger on executions acquires the initial authorization in the
same transaction as executor registration, ownership reservation and delivery
binding. Its failure rolls everything back. There is no historical INSERT or
backfill. Old executions without this sidecar have NULL authorization state,
not a fabricated ACTIVE/UNKNOWN/STOPPED lifecycle.

`evolution_execution_authorization_status.authorization_state` is the effective
operational state: ACTIVE while the persisted permission is ACTIVE and its lease
is valid at PostgreSQL time; UNKNOWN otherwise. It becomes UNKNOWN immediately
on expiration even if nobody is alive to write a transition. A subsequent check
or renewal durably latches UNKNOWN. Revocation/normal completion also persist
UNKNOWN and `revoked_at`; this means no further permission, never executor death.
The immutable Stage 1 `execution.state` remains initial registration evidence.
Consumers must use the authorization view/checks for present permission. The
view alone never authorizes transport: the complete ownership/claim check is
mandatory even while the lease is ACTIVE.

## Temporal policy and renewal

The lease lasts 15 seconds, defined by a PostgreSQL function. The Node timer asks
for renewal every 3 seconds, only while the local invocation remains active.
The timer schedules work; it never decides whether a lease is valid. Every
critical decision and every persisted timestamp uses `clock_timestamp()`.
There is at most one renewal in flight per invocation; no detached promise can
renew a completed, expired, mismatched or locally revoked context.

Renewal locks source/owner first, then authorization. It checks current process
executor/boot identity, immutable execution and complete binding, current owner
reservation, and current sending claim. The database guard rejects resurrection,
ignores caller-supplied timestamps and cannot extend an expired authorization.
Checks re-evaluate time after lock waits. No secret/token appears in diagnostics.

Unknown permission is irreversible in Stage 2. A successful ordinary completion
revokes permission in the existing atomic result/fence finalization transaction.
This existing completion mechanism may release a reservation because transport
completed normally; expiration is never its justification.

## Before effects

1. Commit ownership + executor + execution + authorization + delivery binding.
2. Validate current authorization before entering the operation callback.
3. Validate again after business validation and before durable transport intent.
4. A database trigger validates the immutable binding, exact current ownership,
   claim and permission in the delivery frontier UPDATE itself. It checks time
   **after** obtaining the authorization row lock, including lock waits.
5. The Evolution adapter validates again after its local serialization queue,
   immediately before fetch. Inside an execution this applies to every adapter
   request; messages always require an execution context. Existing non-message
   callers without execution identity retain their existing protocol.

Missing PostgreSQL, denied permission, transaction failure or lost authorization
COMMIT acknowledgement authorizes no effect. Local permission is latched off;
UNKNOWN persistence is attempted but a database outage cannot be hidden by an
invented write. The effective view still expires the durable lease at DB time.
This cannot prevent a process being paused after an already committed transport
authorization; provider-side fencing is outside Stage 2. No later effect gets a
new authorization from that expired context.

## After intent / HTTP

Lease loss does not abort an already authorized HTTP call. The existing HTTP and
operation deadlines remain separate. A conclusive response already in flight
can use the existing finalization. If local authority was revoked, the callback
is late, or the result/commit is ambiguous, delivery stays/becomes uncertain and
retains its fence. No lease event asserts sent, not_sent or STOPPED.

Authorization failures suppress the automatic pre-transport retry path and
retain the reservation. Other conclusively PRE-TRANSPORT failures retain the
existing claim-revocation protocol, only with valid permission; no retry path
was added. The existing unreserved capacity deferral occurs before acquiring
authorization. Existing safe
pre-transport recovery additionally refuses UNKNOWN/expired authorizations,
including revalidation under the recovery transaction's locks. Authorized
claim revocation remains the existing protocol, not a new lease recovery.

## Shutdown, restart and multiworker

SIGTERM/SIGINT shutdown closes local authorization admission before workers and
server shutdown. Recheck after database waits closes shutdown races. Shutdown
does not fabricate STOPPED and does not release uncertain fences. A restart has
a different executor/boot; it cannot renew an old execution. PostgreSQL source
and ownership locks retain multiworker exclusivity. No external supervisor,
automatic release, abandoned_unknown, outbox ordering/unblocking or legacy
recovery was added. Delivery 37 and production tenants were not accessed.

## Migration and rollback

030 creates a new table, functions, view and triggers; no DML backfill, no edits
to migrations 001–029, no changes to historical delivery rows. New frontier
triggers require brief DDL locks on the two delivery tables. `lock_timeout=2s`
bounds acquisition; a failed migration rolls back entirely. The normal migration
runner serializes concurrent startup runners and verifies checksums.

During a rolling deploy, executions created by the old binary after 030 also
receive the sidecar and database frontier protection, but that binary has no
heartbeat. Its existing maximum operation deadline remains 15 seconds. Deploy
must allow normal startup migration completion before service readiness.

Application rollback can retain 030: preexisting evidence is untouched. Removing
030's frontier guards after Stage 2 executions exist would remove protection;
do not do so during an incident or without reviewing active executions. This
change has not run any migration outside the isolated local test database.

## Validation

Node 20.20.1; real isolated PostgreSQL schemas and mocked/loopback HTTP only.
Tests cover exact identity/binding, renewal and denial, server-time authority,
expiry, lock waits, transaction acknowledgement loss, migration rollback and
concurrency, legacy preservation, delayed HTTP queues/callbacks, database loss,
shutdown, real heartbeat scheduling, restart and multiworker isolation.
The harness strips service credentials and blocks external network sockets.
