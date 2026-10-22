# Stage 3B.3A: dormant local supervisor and pre-ACK barrier

Base: `6fc7cddedb9c64b3befe1412c38abf77df8fb5cd`.

This stage is local and isolated. `npm start` remains `node app.js`; the Render
Blueprint and operational settings are unchanged. Neither entrypoint is selected
by the normal startup. The supervisor CLI refuses activation without an explicit
in-process local test authority. No environment switch enables production use.

## Scope and authority

`supervisor.js` imports only Node lifecycle utilities, the environment builder
and protocol. It never imports business code, the application, database or
migrator. Its adapter has `localTestOnly: true`, `enrollBirth`, `openGate` and
`beginDraining`; those are test seams, not implementations of the 031 APIs.

The fixed executor entrypoint is `executorBootstrap.js`. Its two modes are a
permanent subprocess fixture and the real application against an already prepared,
exclusive local PostgreSQL test schema. Both require `NODE_ENV=test`.

There is no real proof issuer, cooperative seal exporter, closure acceptance,
STOPPED writer, persistent gate enrollment or process-exit proof. Exit records
are observations in memory and are never persisted as proof. No reservation,
operation token, delivery state, ordering or retry policy changes belong here.
Migrations 001-031 are unchanged; migration 032 does not exist.

**3B_PERMISSION_SEPARATION_REQUIRED remains CRITICAL/BLOCKER.** Filtering the
environment does not establish OS isolation from a compromised process with
shared credentials/UID/filesystem. This stage does not resolve that blocker and
does not implement 3B.3B, 3B.3C, historical recovery, 3C or Stage 4.

## Bootstrap sequence

1. Install supervisor signal handlers before spawning.
2. Create fresh supervisor/boot/spawn UUIDs, a 256-bit challenge and an independent
   256-bit ephemeral session authentication key.
3. `fork()` a fixed entrypoint, with `detached:false`, `execArgv:[]`, explicit
   stdio/IPC and an explicitly constructed environment. No shell spawns the child.
4. The child creates executor/boot identity and installs a closed startup boundary.
   It imports no application, database, routes, worker or Evolution timer.
5. The parent initializes the private fork channel. The child installs the single
   process guards and returns an authenticated HELLO.
6. The parent checks the actual ChildProcess PID, challenge, identity, revision,
   instance and protocol, then awaits the test enrollment and test OPEN adapter.
7. Every continuation rechecks irreversible shutdown before proceeding.
8. The parent sends an authenticated application ACK. `send()` completion alone
   never opens the child. The child validates the ACK and grants startup once.
9. Only then can the child import/start its runtime. READY confirms runtime startup.

The local bootstrap barrier is separate from the irreversible 3B.2 OPEN/DRAINING/
CLOSED accounting state. `executionScope` also checks this boundary for admission,
so a premature direct import cannot admit roots or unparented continuations.
`app`, the PostgreSQL adapter and the Evolution cleanup timer check it before
their relevant import-time effects. `loadEnv` never reads `.env` while the
supervision boundary exists, including through indirect imports or explicit calls.

After ACK, supervised database startup invokes `schemaAlreadyPrepared` instead
of `migrate`. The supplied local boundary verifies ledger names/checksums by SELECT
only. Identity confirmation uses the test enrollment; neither the app startup nor
subsequent lifecycle registration performs the legacy executor INSERT in this mode.
Lifecycle registration rechecks admission after awaiting enrollment confirmation,
so shutdown during that wait cannot continue into execution-registration SQL.
The legacy path retains its existing migration/identity/worker/listener behavior.

## IPC and liveness

Messages use strict allowlisted flat objects, protocol version 1 and only
`evolution-single-process-v1`. Session fields include supervisor/boot/spawn,
executor/boot, challenge, sequence, revision and instance. No SQL, business payload
or handle transfer is accepted. Messages are bounded to 4096 bytes at validation;
outbound pending sends are bounded to eight. These are application bounds, not a
hostile-peer memory sandbox for Node's underlying IPC deserializer.

HELLO, ACK, READY, heartbeat and STOPPING are HMAC-SHA256 authenticated over a
deterministically ordered representation. The initial key is delivered through
the private fork IPC before any business code is loaded. It is never an env var,
database credential or log field. This protects the cooperative protocol; it is
not attestation of arbitrary hostile code inside the same process.

Sequences are monotonic per direction. The last exact duplicate is idempotent;
a conflicting duplicate, skipped sequence, older replay, malformed frame, wrong
identity/challenge/profile or stale ACK is rejected. Duplicate HELLO does not
rerun enrollment. Out-of-state messages fail closed.

Authenticated heartbeats begin with ACK and cover slow post-ACK startup too.
Both peers use monotonic elapsed time. Child disconnect or heartbeat expiry closes
local admission synchronously and starts cleanup. Parent shutdown closes its
startup/enrollment/ACK path before forwarding SIGTERM to its known child.
No continuation may reopen admission after that barrier.

`exit`, `close`, `error` and `disconnect` remain distinct. Only an actual exit
event records child exit. `done` waits for close and reports any exit observation
separately. `kill()`, `child.killed`, error, disconnect and deadlines never create
proof. There is no restart loop, no inference about SQL surviving process death,
and no claim that a local timeout proves the supervisor died.

## Runtime profile and environment

Before business code, guards deny known child-process creation APIs, cluster
fork, Worker construction, Puppeteer and WPPConnect loading. Builtin ESM exports
are synchronized to the blocked functions. Thus legacy browser creation is denied
before invocation, rather than merely blocking certification afterwards.
`npm run bot` cannot be launched from this profile. These guards are cooperative
containment, not an OS sandbox against malicious code/native dependencies.

The environment builder copies only named application, platform, Render metadata,
Evolution, Mercado Pago and email variables. Aliases are explicitly normalized.
PATH and HOME are controlled. DATABASE_URL is supplied separately as an executor
credential; the supervisor source DATABASE_URL is never copied. Issuer/migration/
infrastructure secrets, unknown variables, NODE_OPTIONS, npm_config_*, dynamic
loader variables and legacy browser configuration are omitted.

## Validation and outstanding Linux gate

Standard tests: `node --test test/supervision-*.test.js`, with Node 20.20.1 and an
exclusive TEST_DATABASE_URL for the real PostgreSQL/app integration test.

Mandatory additional Linux command:

```
node --test test/supervision-signals.linux.cjs
```

That gate asserts Linux and Node 20.20.1; it cannot be approved by running Windows
tests or by skipping it. It exercises real OS signals, child death, parent death
and an explicit future npm/shell fixture without changing the repository start
script. The npm test must expose, rather than mask, any forwarding failure. A
failure requires a future direct/exec entrypoint and operational approval.

Windows JS-handler races and real Windows subprocesses are useful evidence but
do not certify Linux signal semantics. Linux/Node 20.20.1 validation is **PENDING**
until actually executed. This stage must not be declared ready for commit/push/
deploy while that mandatory validation remains pending. No production signal,
WhatsApp test, credential operation or real delivery access is part of validation.

Both the standard supervision suite and the separate signal gate must be executed
and approved on Linux/Node 20.20.1. Their status is **PENDING / PENDENTE**; Windows
results, including the complete regression suite, do not fulfill either Linux
requirement. No Linux approval is inferred from a previous stage or another runtime.
