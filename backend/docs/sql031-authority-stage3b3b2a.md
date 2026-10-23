# SQL031 authority adapter: dormant stage 3B.3B.2A

Base: `17238ea19db3db0a6a83d81ba637839aa2abb95b`.

These modules are not imported by app, supervisor, bootstrap or bridge. They do
not create a pool, read environment variables, schedule work or run migrations.
The existing startup, persistentEmissionEnabled=false and
3B_PERMISSION_SEPARATION_REQUIRED remain unchanged.

## Explicit local composition

Create a control SQL runner with an injected issuer pool, three distinct login
names, authority=SUPERVISOR_PROOF_ISSUER and localTestOnly=true. The database must
be named test_sql031_<32 lowercase hexadecimal digits>; schema must be
test_<32 lowercase hexadecimal digits>. Each acquired connection must actually
use that database, an allowed loopback host and the declared issuer login.
Client-only query_timeout is prohibited: a caller deadline is not SQL completion.

Every transaction checks session_user, current_user, administrative flags,
schema/database ownership, schema CREATE, migrator/executor membership and direct
ledger write privileges. A label is not proof of authentication. Production role
provisioning, proxy login separation and OS secret isolation are outside this
stage. A shared owner credential or SET ROLE is not adequate separation.

Construct the authority with this runner and a fixed supervisor/boot identity.
The seven fixed operations are registerSupervisor, registerExecutorBirth,
openExecutorGate, beginExecutorDraining, acceptCooperativeClosure,
listExecutionSubjects and acceptExecutionStop. snapshot exposes only accounting.
No arbitrary SQL/function/proof interface is exposed by the authority.

Each operation has its own transaction. Birth itself atomically creates the new
029 executor, birth binding and BOOTSTRAPPING gate using SQL031. The gate wrappers
cannot request CLOSED. Cooperative acceptance closes the gate through the SQL
function. No process-exit modality is accepted.

## Payload and provenance boundaries

Inputs use strict own data properties, canonical lowercase UUIDs, explicit enums,
canonical UTC timestamps and bounded identifiers. Positive PostgreSQL bigint
values are decimal strings, or safe integers converted to decimal strings.
Unknown fields, getters, symbols, null violations and unexpected prototypes fail.

Birth requires explicit session_challenge material. Its nonce fingerprint hashes
the domain studiofy.executor-birth.v1: plus a fixed ordered JSON tuple of
supervisor, supervisor boot, spawn, executor, executor boot and challenge. The raw
challenge, HMAC key and capabilities are never included in the SQL payload.

Closure evidence must supply every SQL031 counter explicitly. Validation of this
shape is not attestation of a real seal. Only synthetic local composition may
call this adapter now; real scope ownership and authenticated bridge binding are
the future 2B responsibility. Hostile JavaScript inside a trusted child is not
made trustworthy by this adapter or by HMAC.

Subjects are selected by a modern CLOSED executor/birth, fixed supervisor/boot,
issuer session and existing authorization, with bounded UUID pagination. They are
never selected by delivery ID. Token fingerprints are derived in PostgreSQL with
studiofy.operation-token.v1:, without returning the token. Closure evidence hashes
are read from the persisted event, using pg-jsonb-v1, not IPC canonicalization.

Only exact subject and closure receipt objects returned after confirmed COMMIT
by the same authority can supply acceptExecutionStop. Copies, cross-authority
objects and extra subject override fields fail. Proof IDs and idempotency keys
are parent inputs; the adapter never generates or changes them for retries.

## Transaction outcomes

CONFIRMED requires actual COMMIT acknowledgement with command=COMMIT. A known
rejection is KNOWN_FAILURE only with sufficient transaction/rollback knowledge.
Connection loss, client timeout, uncertain COMMIT, uncertain ROLLBACK and unresolved
queries produce UNKNOWN. Even a caught ambiguous query poisons the attempt.
UNKNOWN blocks subsequent operations on that runner and discards its connection.
There is no retry, read-back repair or blocker reset. A real commit can exist in
the database despite an UNKNOWN result; absence of acknowledgement is not rollback.

Accounting belongs to this control runner, never the child executionScope. No
business blockers are cleared. Driver messages and credentials are not returned.

Real PostgreSQL tests provision distinct disposable LOGIN roles, migrate using
only the migrator, grant only explicit issuer APIs/reads, and verify executor
denial and business snapshots. STOPPED exists only in that explicit synthetic
SQL fixture. No runtime STOPPED orchestration, recovery, reservation release,
delivery reconciliation or ordering change is implemented.
