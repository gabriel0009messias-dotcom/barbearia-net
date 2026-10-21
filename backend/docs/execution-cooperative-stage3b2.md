# Stage 3B.2: dormant local cooperative closure

Base: dfac8ef8790564bad7737b630562953d5bf6cfbf.

This stage supplies a local capability, not a proof of process death or delivery
outcome. It never enrolls a supervisor/birth, opens a persistent gate, invokes
the 031 closure/proof APIs, creates STOPPED, retries a message, reconciles an
uncertain outcome or releases a reservation/token. Migration 032 is absent;
001-031 and npm start are unchanged.

## Certification contract

Every relevant operation must either be awaited by a live task or register a
descendant/obligation before starting. `follow` requires a live parent in the
certifiable profile. `enqueue` registers a queued callback before scheduling it;
cancelling a not-yet-started callback resolves its obligation and makes even an
already-queued invocation inert. It is not a universal detector of arbitrary
Promises, native handles or malicious code within the same process.

The application opts into certification with a required resource manifest:
HTTP listener, outbox scheduler, reminders scheduler and Evolution cleanup timer.
Independent return-reminder workers register dynamically. The coordinator closes
admission synchronously, calls resource stops synchronously to fence scheduling,
then awaits their completions and the complete task/obligation tree. Worker stop
is distinct from completion of work already started. Relevant handlers include
the main WhatsApp router, alternate services, temporary admin handler and booking
routes. SQL transaction-body accounting outlives booking capture until COMMIT or
ROLLBACK; disconnecting HTTP does not complete that work.

The old, explicitly noncertifiable 3A scope retains legacy drain/diagnostic
compatibility. It can never produce a seal. Once the application enables the
certifiable profile, it cannot opt out, and required resource kinds cannot be
removed. Certification requires an executor/boot identity; failed/incomplete
startup does not satisfy the resource manifest.

Known relevant detached work must call `blockCertification`. Unsupported SQL
interfaces, pipelining, missing transaction-status support and use of the legacy
WPPConnect provider also block certification. The latter is outside the certified
single-process Evolution profile, potentially creating browser descendants. Its
SDK entry checks admission before starting. These restrictions do not certify
the absence of arbitrary third-party native descendants.

## SQL lifetimes

The central accounting proxy wraps the application pool and every borrowed
client. It covers acquisition, autocommit, Promise/callback queries, callback
completion, borrowed-connection lifetime and transaction status. The normal DB
adapter additionally accounts for transaction bodies and its callback APIs.
Direct ownership, delivery-guard and return-reminder queries use that same pool.

`query_timeout` is implemented as a caller deadline, leaving the driver's actual
completion callback intact. A caller timing out does not decrement the actual
SQL obligation. A released client is not returned to the pool while its real
queries are pending, and the old client wrapper rejects reuse. Pool query
deadlines also retain the client until the operation really finishes.

Known server errors are accounted through ReadyForQuery. Transaction status
preserves START TRANSACTION, multi-statement queries and ROLLBACK TO SAVEPOINT;
only a confirmed idle transaction state ends the transaction obligation. The
protocol handling is tested against the locked pg 8.23.0 driver. This is an
internal adapter, not a supported escape hatch to raw clients/connections.

Lost connection/results, ambiguous COMMIT, or release of an open transaction
block certification with CERTIFICATION_BLOCKED_UNKNOWN_SQL. Unknown obligations
are retained for the boot; later ROLLBACK cannot erase them. No automatic recovery
is implemented. A fully observed delayed completion is distinct from a lost
result: it may eventually finish its original obligation. Acquisition failure
also blocks certification conservatively. A shutdown deadline reports incomplete
drain; it never fabricates closure, cancels accounting or produces a seal.

## Transport lifetimes

Existing structured tasks retain Evolution request/queue, HTTP, awaited body,
diagnostic reads/cancellation, transport callbacks, provider correlation, retry
wait and finalization. Cancellation failure blocks certification. An aborted or
network-failed transmitted request conservatively records
TRANSPORT_TERMINATION_UNCONFIRMED instead of asserting that abort proved closure.
Pending registered callbacks remain counted after a caller deadline. Existing
boundary and renewal checks still deny new effects during drain.

An external provider may already have accepted a request. Local closure never
infers sent/not_sent or resolves that delivery outcome. A future authenticated
historical event must use independent authority and cannot resurrect an old task.

## Local seal

`sealClosedScope()` checks the certifiable profile, CLOSED, immutable executor/boot
identity, required resources observed, zero tasks, zero capabilities, zero SQL/
other obligations and zero blockers. Final validation and construction are
synchronous without an await or caller callback. The privately retained frozen
object includes seal_id, executor_id, boot_id, protocol_version, runtime_profile,
closure_generation, frozen final counters and auxiliary monotonic time. Repeated
calls return the same object. `ownsSeal` checks object identity; a copied JSON
has no equivalent authority. Admission, descendants, transports and SQL with an
expired context remain fenced. No runtime shutdown emits or persists a seal
automatically; an authorized future controller may request the local capability.

## Persistent activation remains blocked

**3B_PERMISSION_SEPARATION_REQUIRED** remains CRITICAL for activation. Separate
migration, proof issuer and normal executor credentials and establish the trusted
issuer before enabling real evidence. `persistentEmissionEnabled` is a fixed
false contract, not an environment flag. There is no persistent adapter that
could be accidentally enabled in this stage. Future acceptance must run in the
separate control authority, outside the sealed executor, using 031 atomically.

The local capability is not isolation against the shared migration owner, which
still has administrative privileges. This stage does not implement 3B.3, 3C,
process supervision, real proof issuance, delivery recovery or operational
credential provisioning.

## Verification

Adversarial scope tests cover active work/descendants/transports/callbacks,
queued/fired timers, manifest omissions, failed resource stop, late authority,
known detached work, idempotence and boot isolation. Real PostgreSQL tests cover
pg_sleep surviving caller timeout, deferred release, callback completion,
transactions/savepoints, unavailable DB and a real COMMIT whose acknowledgement
is deliberately replaced with a network error. That last fault injection does
not claim to reproduce every physical network-loss window.

Isolated SQL fixtures equivalent to deliveries 37 and 69, ownership/reservations,
and proof foundation tables are compared before/after sealing. A stale callback
attempting to mutate those fixtures is rejected. A real application subprocess
verifies listener/worker closure before local sealing, and a real HTTP test
verifies that finishing a response does not finish its async handler. All tests
require an exclusive test database; production and barbearia-1 are never targets.
