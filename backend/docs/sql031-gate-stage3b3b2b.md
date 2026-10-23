# 3B.3B.2B: dormant gate and cooperative closure composition

Base: `813254b9ed8cfe46eeda62c374debf516df6c315`.

`createDormantSql031Gate` is an explicit local-test composition, with no caller
in startup, app.js, supervisor.js, executorBootstrap.js, workers or admin routes.
Importing it creates no scope, connection, timer, listener or runtime composition.
There is no environment switch. `persistentEmissionEnabled` remains false and
`3B_PERMISSION_SEPARATION_REQUIRED` remains the activation blocker.

## Composition and trust boundary

The trusted parent composition injects the authentic 2A transaction runner,
supervisor record, observed birth record and required capability manifest.
The parent must obtain those records from the authenticated supervised bootstrap,
including the observed child PID and the current spawn/challenge. They are not
arguments to executor methods or business requests. Records are validated, copied
and bound before any await; identities cannot be changed through lifecycle calls.
SQL031 rejects adopting a legacy executor with no birth. The 2A runner still
requires separate issuer/migrator/executor LOGINs, checks session_user/current_user
and real connection identity, and supports only loopback isolated test databases.
No SET ROLE, production connection, credential, environment or pool is created.

Only the frozen `executor` capability goes to trusted work adapters. It exposes
structured admission, descendants, callbacks, obligations and capability shutdown;
it exposes no runner, issuer, bootstrap, gate transition or closure operation.
This is an object capability boundary for trusted composition, not a security
sandbox against hostile code with arbitrary JavaScript or database credentials.

This round implements the opt-in control composition against an owned local scope.
It reuses `createExecutionScope`, `createCapabilityCoordinator` and their authentic
cooperative seal. It does not replace or modify the authenticated IPC bridge,
start/fork an executor, or wire the existing real supervisor to SQL. Transporting
closure evidence across processes remains a separate explicitly audited composition;
an IPC seal ID alone must never be used to manufacture zero accounting counters.

## Lifecycle

1. Register shutdown capabilities through `executor.registerCapability`.
2. `bootstrap()` confirms supervisor registration and then executor birth. Admission
   remains closed; the acknowledged persistent gate is BOOTSTRAPPING.
3. `open()` persists OPEN and waits for COMMIT acknowledgement before permitting
   `executor.admit`. No local success substitutes for a rejected or unknown write.
4. `close({ timeoutMs })` fences admission synchronously, persists DRAINING, then
   runs the existing capability coordinator drain. Its default deadline is 1000ms;
   callers may explicitly choose 0..120000ms. No deadline means transport success.
5. Only a completed structured drain, complete capability coverage, no certification
   blocker/obligation and coherent control accounting permit the existing scope seal.
   Promise.race does not discard surviving descendants. Required capabilities are
   supplied explicitly; this code does not certify uninstrumented external work.
6. The closure payload projects fields from that owned seal. No child or caller
   evidence, identities, exit observation or arbitrary CLOSED target is accepted.
   SQL031 `studiofy_accept_executor_closure` is the only CLOSED persistence path.
   CLOSED is reported only after its 2A CONFIRMED result.

Control operations are sequential and single use. Overlapping/repeated lifecycle
calls cannot duplicate SQL or reopen a drained boot. The owned scope does not bypass
the existing process supervision admission boundary. Factory construction within
an installed executor supervision context is rejected.

## Failure and accounting

CONFIRMED and KNOWN_FAILURE are preserved from 2A. A rejected persistent operation
terminates this composition fail-closed. An ambiguous operation or lost COMMIT ACK
is terminal UNKNOWN; the gate's knowledge becomes UNKNOWN, not CLOSED. No retry,
repair, reset, read-back query or automatic reexecution is provided. This includes
bootstrap, birth, OPEN, DRAINING and closure. Local drain timeout or invalid seal
fails closed, leaves the last confirmed gate unchanged and issues no closure SQL.

Control accounting must have no pending/in-flight/unresolved SQL or blockers, no
known failures, and matching attempts/confirmations. A dedicated runner is required;
sharing it with unrelated work is unsupported and inconsistent accounting blocks
admission/closure. Scope transport, callback, correlation and SQL obligations are
tracked separately. An unknown obligation irreversibly blocks certification;
calling finish afterward does not reinterpret its outcome. No transport outcome
is inferred from completion or process exit.

## Exclusions and validation

There is no subject listing, acceptExecutionStop integration, STOPPED projection,
process-death proof, reservation release, retry, outbox mutation, uncertain recovery,
reminder activation or migration change. SQL031 already supplies birth, monotonic
OPEN/DRAINING, closure validation and closure-only CLOSED. Migration032 is unnecessary.

The new focal tests use the real 2A adapter/runner and real structured scope with
an injected synthetic SQL driver, including commit-ACK loss at each transition.
They are not a new PostgreSQL, OS-process or Linux-signal certification. Existing
2A PostgreSQL evidence is unchanged. Broader regression, Linux signals and full
suite are deferred to later gates. No production or protected entity is accessed.
