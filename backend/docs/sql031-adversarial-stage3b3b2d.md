# 3B.3B.2D: dormant adversarial validation candidate

Base: `e0884b9d47f16ed410f0d39d0ef99faf899872af`.
This candidate adds only four test files, one test helper and this document.
Implementation and static inspection are authorized; no tests have been run for
this candidate. An implemented assertion is not a passing validation result.
No existing file, production module, startup script or migration is changed.

## Purpose and boundaries

Challenge authority, gate monotonicity, structured drain, closure provenance,
individual execution STOP, terminal UNKNOWN, pagination, permissions, transport
isolation, legacy rejection and process-event false inference. CLOSED is necessary
but insufficient for individual STOPPED. Execution STOPPED never means transport SENT.

The JavaScript capabilities constrain trusted composition. They are not an OS
sandbox against arbitrary code that already holds legitimate issuer credentials.
Two-supervisor tests reject incompatible bindings; two-issuer tests authenticate
distinct PostgreSQL logins. Sharing one compromised issuer credential is not an
isolation guarantee provided by these tests.

UNKNOWN remains terminal for the current runner/capability. Repeated calls must
reuse the same terminal result/attempt and issue no SQL, new proof IDs, retry,
repair or automatic reconstruction. No guarantee against arbitrary MANUAL
reconstruction after a restart is claimed. Observer reads by tests are not runtime
read-and-retry logic. SQL idempotency is not permission for runtime retry.

## Implemented matrix, not yet executed

U = unit model with real production composition and a synthetic SQL driver.
PG = real isolated local PostgreSQL. P = actual child processes/IPC with an explicit
nonpersistent test authority. L = separate real Linux signal gate.
Negative cases permit no new accepted proof. Legitimate STOP permits only its
proof/projection and authorization ACTIVE-to-UNKNOWN; business snapshots stay equal.

| ID | Attack and expected result | Layer / files | Allowed mutation |
|---|---|---|---|
| A01 | Executor has no issuer surface; SQL APIs and forged IPC denied | U/PG/P | Fixture setup only |
| A02 | Other supervisor/issuer cannot operate foreign birth, closure or proof | PG | Fixture setup only |
| A03 | Tenant, instance, executor, boot, execution, claim, schema crossed individually: atomic rejection | PG | None |
| A04 | Raw token/incorrect fingerprint, copied subject and caller subject override rejected | U/PG | None |
| B01 | Direct CLOSED, reopen and regression attempts rejected; gate monotonic | PG | Legitimate transitions only |
| B02 | Admission after DRAINING/CLOSED never executes callback | U | None |
| B03 | Follow/enqueue without parent in OPEN/DRAINING/CLOSED or expired context: no orphan or scheduled callback | U | None |
| B04 | KNOWN_FAILURE supervisor/birth/OPEN/DRAINING terminates; rollback and previous committed SQL gate retained | U | Earlier confirmed control only |
| C01 | Pre-drain closure/incoherent accounting refused | U/PG | Earlier confirmed control only |
| C02 | Transport/callback/correlation/SQL/capability blocker survives timeout without valid closure | U | None |
| C03 | Copied/tampered/foreign-authority receipt and foreign-login closure rejected | U/PG | None |
| C04 | KNOWN_FAILURE closure terminal; no new capability/retry/repair/reexecution | U | Previous DRAINING retained |
| D01 | Before CLOSED or without legitimate closure: no accepted STOP | U/PG | None |
| D02 | Cross execution/collective attempts denied; A proof does not promote B | U/PG | Individual valid A only |
| D03 | Missing/extra/null/type/version payload rejected without partial acceptance | U/PG | None |
| E01 | Real control/proof COMMIT followed by discarded ACK becomes UNKNOWN | PG; U complements fault coverage | COMMIT may exist in DB |
| E02 | Later calls remain terminal, no SQL/new IDs/new automatic capability | U/PG | None additional |
| F01 | A confirmed, B real COMMIT ACK lost, C untouched; cursor stops at A | PG | A/B may be persisted |
| F02 | 0/1/99/100/101/200/201 ordered subjects, private cursor, explicit continuation and concurrency | U | Individual proofs in model |
| F03 | Reversed/duplicate/cross-executor/cross-boot page rejected before first proof | U | None |
| G01 | Real lease deadline with no heartbeat does not infer STOPPED; closure timeout does not certify | PG/U | Authorization knowledge may expire |
| G02 | Real disconnect/restart and synthetic error/revision attacks: observe PID, exit, enrollment and IPC; no SQL persistence claim | P | Test-authority observations only |
| H01 | STOP leaves transport uncertain, never sent/failed/pending | PG | STOP control only |
| H02 | Nonempty linked disposition, reservation, outbox responses and ordered pending inbox stay unchanged; instrumented fetch unused | PG | STOP control only |
| I01 | Executor issuer API/DML/TRUNCATE/DDL and SET ROLE attempts denied | PG | None |
| I02 | Migrator or overprivileged issuer rejected by runner | PG | Temporary fixture grant only |
| I03 | Direct session identities, second issuer, membership and changed current_user attacks | PG | Temporary fixture membership only |
| J01 | Synthetic uncertain legacy reservation: no retroactive birth/closure/subject/proof/STOPPED | PG | Fixture preparation only |
| K01 | Real kill request/signals/exit/parent loss: process and wire evidence; SQL persistence requires separate PG gate | P/L | Process observations only |
| K02 | Valid cooperative payload versus identical payload with process-exit modality; cooperative validator/authority refuse substitution | U | None |
| L01 | Helper/composition import with activation variables: no known instrumented effects, complemented by static imports review | U | None |
| L02 | No test/helper import in production, startup activation or migration added; npm start preserved | U/static audit | None |

The unit transaction model distinguishes pending writes, rollback and confirmed
commits. It is not PostgreSQL evidence. The PG ACK-loss injector first awaits the
actual COMMIT, then throws; this deliberately permits persisted B while the runtime
knows only UNKNOWN. Test observer connections inspect persistence separately.
The boundary cardinalities in F02 are unit coverage, not a claim of PG pagination
load certification. Process/IPC tests have no SQL closure issuer.

## Static-audit corrections, not yet functionally validated

B04 adds explicit OPEN and DRAINING rejection cases using the existing gate,
authority, transaction runner and execution scope. Only the SQL driver injects
23514 for the selected transition. Assertions require acknowledged rollback,
FAILED terminal state, the previous BOOTSTRAPPING/OPEN SQL gate and commit list,
no later admission, connection, SQL, closure, proof or STOP capability. Repeated
calls and an event-loop turn must not retry, repair or reconstruct the composition.
The driver is synthetic; these cases are UNIT evidence, not PostgreSQL execution.

H02 prepares two synthetic uncertain deliveries with nonzero attempts, null
sent_at, live ownership tokens and matching execution/claim bindings. Each has
an existing-schema abandoned_unknown reconciliation/disposition, a conversation,
response links to both the uncertain delivery and a pending outbox message, and
two awaiting_delivery inbox entries with increasing durable received_order.
This uses the existing conversation inbox order; no new order table is invented.
Assertions require populated linked rows before STOP, then compare full rows
including conversations, inbox order, disposition, tokens, reservation, attempts,
sent_at and business data afterward. Control snapshots permit one new proof and
individual STOP; authorizations permit only the target's SQL031 revocation fields.
Null sent_at is an explicit invariant for the uncertain fixture, not a claim that
its transport was sent. No actual transport is invoked to prepare these facts.

The H02 operation invokes the fixed SQL031 function through the issuer connection;
the test does not invoke a JavaScript messaging adapter. The fetch assertion means
only: this SQL031 STOP path did not invoke the instrumented fetch transport seam.
It does not universally prove that all network APIs or all transport paths are inert.

PROCESS EVIDENCE is distinct from PERSISTENCE EVIDENCE. G02/K01 now record the
actual parent-to-child and child-to-parent IPC types without replacing messages,
and correlate spawn/ready/exit observations with the child's PID and enrollment.
Linux additionally observes real signals, parent shutdown, child exit and listener
withdrawal after parent loss. Synthetic error/message notifications remain labeled.
The optional forbidden authority callbacks are sentinels: the current supervisor
has no callable SQL cooperative-closure/STOP seam. Constant proof/stopped flags
are retained as contract checks, not as database evidence. No SQL persistence
claim follows from K01 alone; PostgreSQL/lifecycle tests certify their own separate
database scenarios. Wire observations do not invent an infrastructure authority
or prove the still-absent positive IPC-to-SQL integration.

A01/G02 retains the injected STOPPED attack and requires its observation and
protocol rejection. A harness-owned WeakSet marks that input only during injection;
message fields cannot claim this provenance. Supervisor outputs and real child IPC
remain distinct and forbidden STOPPED/proof outputs are still rejected. Assertions
also require protocol failure, no cooperative ACK/closure and no new authority call.
These are process/control observations, not evidence of SQL persistence.

K02 first validates a complete cooperative payload from the real local composition,
then changes only proof_type to SUPERVISOR_PROCESS_EXIT. The cooperative payload
validator and authority reject that substitution before SQL. The public close()
API accepts only timeout options and has no process-exit mode: its rejection is
LIMITED BY THE BOUNDARY and carries no modality-specific diagnostic claim. K02
therefore combines architectural separation with the existing SQL/foundation
modality rules; it does not reclassify process exit as cooperative evidence or
add an infrastructure proof issuer.

L01 instruments known timer, child-process, server-listener, TCP/TLS, HTTP(S),
fetch, datagram, worker, PostgreSQL-module and file-write seams in an isolated
future child probe. It checks process listeners and that helper import exports
fixture functions without loading the database/provisioner or supervisor.
Conclusion: no known/instrumented side effect occurred on import, complemented
by static import inspection. This is not a universal side-effect detector.
The probe is written but has not been executed in this correction round.

The previous physical freeze is superseded by the six new physical hashes
reported after this correction. Syntax checks do not validate these behaviors.

## Seven previously recorded 2B gaps

1. ADMISSION AFTER CLOSED: direct B02 assertions added.
2. FOLLOW WITHOUT PARENT: B03 covers three gate states and expired context.
3. ENQUEUE WITHOUT PARENT: B03 checks no callback, no orphan and no scheduler call.
4. KNOWN_FAILURE SUPERVISOR: B04 checks rollback, terminal FAILED and no later birth/OPEN/proof.
5. KNOWN_FAILURE BIRTH: B04 permits the supervisor commit, then rejects progression.
6. KNOWN_FAILURE CLOSURE: C04 checks prior DRAINING, terminality and no automatic reconstruction.
7. REAL SUPERVISED EXECUTOR / IPC: only negative P/L coverage is added.

None of these gaps is declared validated or closed before the corresponding tests
run and are audited. The positive chain real child -> authenticated IPC -> complete
child evidence -> SQL031 closure -> STOP proof remains a later integration.
The existing bridge does not carry the complete evidence needed for this chain.
Never invent zero counters from seal_id, a fake child scope or a synthetic receipt
represented as authentic child evidence. Synthetic unit receipts are labeled and
remain confined to the synthetic driver model.

## Isolated PostgreSQL permissions and teardown

TEST_DATABASE_URL must explicitly name a local `test_*` database, use a PostgreSQL
scheme and a literal loopback/localhost host with no URL parameter overrides.
Missing or nonlocal configuration fails; no skip/todo fallback exists. The
provisioner creates a new `test_sql031_<random>` database and ephemeral password
LOGINs for migrator, executor, issuer and adversary. It is not a runtime login.

Each runtime pool authenticates directly. Checks require session_user=current_user
and the expected login outside SECURITY DEFINER calls. The migrator applies existing
migrations and grants only fixture privileges. Executor gets schema USAGE without
issuer EXECUTE or ledger DML. Issuers get necessary SELECT and fixed control APIs,
without table DML, ownership, schema CREATE or administrative/migrator/executor roles.
Membership/SET ROLE is used only for explicit negative attacks and is reverted in
finally. A provisioner-only helper limits membership changes to its own created roles.
Teardown attempts every pool close, owned database drop and created-role drop,
then reports aggregate cleanup errors rather than silently hiding them.

Local permission evidence does not certify production deployment separation.
`3B_PERMISSION_SEPARATION_REQUIRED` stays preserved; persistent emission stays false.

## Process exit, dormancy and validation gates

Process exit is not a cooperative proof. The SQL foundation's existing process-exit
modality is not a runtime infrastructure authority. No such authority is added.
Whole-instance loss remains separate. The Linux file hard-fails outside Linux and
the approved Node 20.20.1 runtime; it is not hidden behind a platform skip.

All subprocesses use fixed local fixtures and ephemeral loopback listeners. Revision
replacement is synthetic metadata, not a deploy. No real provider or messaging
transport is used. No startup, worker, timer, cron, endpoint, environment activation,
npm start change or automatic production supervisor is introduced.

No migration032 is created and migrations029/030/031 remain unchanged. A real bug
requiring runtime/schema/existing-file changes is a blocker for a separate review;
do not repair it as part of this candidate or weaken its expected assertions.

Required later gates, separately authorized: code audit; focal U/P/PG validation;
the frozen prior 46-file regression selection plus three new .test.js files; existing
and new Linux signal files; full suite; physical/clean-content/blob freeze; pre-commit
audit; one local commit; pre-push audit; controlled push. No deployment is included.
Production remains inactive and READY TO ACTIVATE IN PRODUCTION remains NO.
