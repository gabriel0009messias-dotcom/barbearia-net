# SQL031 stage 3B.3B.2C ? DORMANT cooperative STOP integration

Base: `a3be5bc82744ac601059225656d0ef5caaf8838e`. No migration or SQL031 change.
This is an explicit, isolated-test-only composition. It adds no startup import,
worker, timer, endpoint, environment activation, connection pool or production activation.
`persistentEmissionEnabled` remains false and `3B_PERMISSION_SEPARATION_REQUIRED`
remains the activation blocker. A real permission-separated supervisor deployment is
still required before a later activation decision; this stage does not provide one.

## Supervisor composition and provenance

The trusted 2B parent retains its original SQL031 authority and the original frozen
receipt returned by a CONFIRMED cooperative closure. Only that parent exposes
`gate.createStopProjection()`. It rejects calls before valid birth, drain, authentic
scope seal, CONFIRMED closure, CLOSED gate and coherent control-SQL accounting.
No receipt, binding, subject list, cursor, proof payload or other caller arguments
are accepted. The executor facade never receives the constructor, authority,
receipt, subjects, raw SQL or stop API.

The internal `createDormantSql031StopProjection` constructor is a trusted-parent
composition seam, not a security boundary against arbitrary code in the parent
process. It does not create another authority. Receipt and subject object identity
are enforced by the existing authority's private WeakSets. Frozen receipt copies,
JSON reconstruction and receipts from a different authority cannot issue a proof.
The positive gate integration test also exercises the original receipt through the
same private authority. No WeakSet, payload validator or permission rule is relaxed.

## CLOSED != STOPPED

CLOSED certifies the cooperative scope; it produces no execution STOPPED projection.
`certifyNextPage()` obtains at most 100 subjects from the existing authority/ledger
reader, bound to executor, boot, supervisor, modern birth, CLOSED gate, issuer login
and tracked authorization. The capability accepts no arguments. Its only other
method is `snapshot()`, which returns frozen state and confirmed identities.
There is no selector by delivery and no adoption of a legacy/unbound execution.
In particular, delivery37 is ineligible by construction without a modern birth;
that protected delivery is never queried, used as a fixture or modified.

Each subject needs an individual proof and its own acceptance transaction.
The proof of A does not promote B. The SQL031 proof ledger and execution-stop ledger
back the lifecycle view's individual STOPPED projection; there is no bulk update.
SQL031 may revoke execution authorization from ACTIVE to UNKNOWN in that same
transaction. This authorization change is distinct from transport uncertainty.

## Result protocol, pagination and uncertain COMMIT

Each individual attempt generates one proof_id and one idempotency_key and retains
those IDs if the result is ambiguous. Only an individual CONFIRMED COMMIT advances
the private cursor. Concurrent page calls share the pending promise. A full page
requires another explicit call; a short page completes the capability. Completion
returns the cached result on later calls without SQL. Previous confirmed subjects
are not submitted again when advancing a page.

KNOWN_FAILURE stops the capability. UNKNOWN is terminal, including an actual
COMMIT whose ACK was not observed. There is no retry, repair, read-and-retry or
reexecution. The parent returns the same cached capability after failure; it does
not create a fresh session to evade UNKNOWN. The terminal result retains the
confirmed prefix, cursor and unresolved attempt. A page is not a collective atomic
transaction: A and B may remain CONFIRMED while C is UNKNOWN. SQL-level identical
replay is idempotent, but the runtime never invokes it to retry UNKNOWN.

## Evidence and business isolation

Closure/proof canonicalization stays `pg-jsonb-v1`, separate from JS/HMAC or IPC
canonicalization. The original receipt's evidence_hash is reused, never recomputed
with JSON.stringify. SQL031 validates the fingerprint against
`sha256:SHA256(UTF8("studiofy.operation-token.v1:" + operation_token::text))`.
The subject/proof/capability never exposes the original operation_token and does
not replace PostgreSQL validation with a JS fingerprint implementation.

STOPPED describes execution lifecycle only. Transport UNKNOWN remains UNKNOWN;
uncertain is not pending or NOT_SENT. There is no delivery retry, reservation
release/clear, token clear/change, disposition change (including ABANDONED_UNKNOWN),
outbox unlock, contact reordering or WhatsApp send. The real PostgreSQL tests compare
complete delivery, owner/reservation/token, reconciliation/disposition, execution,
reminder and outbox/correlation snapshots before and after acceptance, including
linked uncertain deliveries and unrelated pending outbox entries.

SUPERVISOR_PROCESS_EXIT and whole-instance-loss proofs are outside 2C. PID absence,
lease expiration, heartbeat absence, socket closure, deploy, restart, presumed
SIGTERM or a closed database connection are never cooperative STOP evidence.

## Validation scope and remaining gaps

Run only `sql031-stop-integration.test.js`,
`sql031-stop-integration-postgres.test.js`, and the affected
`sql031-gate-integration.test.js` with Node 20.20.x. The PostgreSQL test creates a
fresh isolated test database/schema on an exclusively local server, authenticates
three distinct nonprivileged LOGINs (migrator, executor and issuer), and never uses
SET ROLE. It checks denies/grants, identity, ledger provenance, SQL mismatches,
rollback atomicity, actual lock contention, idempotency, and committed proof ACK
loss. Its fault injection occurs around a real issuer connection, not a simulated
PostgreSQL response. SQL-negative payloads are test-only and never accepted by the
runtime capability. Test infrastructure drops its own database/roles at teardown.

No broad regression, Linux signals or full suite is authorized in this round.
Stop at the first failed real validation round; do not fix and rerun automatically.
The existing 2B test count before this change is 39; zero tests are removed and
only its supervisor/executor surface assertions change.

The seven recorded 2B gaps remain separate: ADMISSION AFTER CLOSED, FOLLOW WITHOUT
PARENT, ENQUEUE WITHOUT PARENT, KNOWN_FAILURE SUPERVISOR, KNOWN_FAILURE BIRTH,
KNOWN_FAILURE CLOSURE, and 2B REAL SUPERVISED EXECUTOR / IPC. The new 2C test that
injects a known closure failure explicitly verifies that no STOP capability can be
created. This incidentally covers that narrow 2B closure failure outcome; it does
not claim the entire pre-existing gap resolved. No other gap is claimed resolved.

Production permission separation and runtime activation remain unimplemented.
No production/Render/Evolution/WhatsApp access, commit, staging, push or deployment
is part of this stage. Passing focused tests makes this candidate eligible for a
separate code audit, not for activation.
