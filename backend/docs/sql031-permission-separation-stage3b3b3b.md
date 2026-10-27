# 3B.3B.3B — Permission Separation Foundation

Base: `9be47e89e9c7d1b758161c827e56f3b33cf987ab`. Dormant, local-only.
No migration, deployment, production grants, transport activation or IPC redesign.

## Trust and permission matrix

| Login | Allowed | Denied / scope |
| --- | --- | --- |
| MIGRATOR | Own the disposable database/schema and prepare existing migrations | No administrative attributes; never a runtime child credential |
| ISSUER | SELECT of execution/control evidence; five SQL031 SECURITY DEFINER control APIs | No business DML, direct control-ledger DML, sequences, structural ownership, CREATE/TEMP or role membership |
| EXECUTOR | Explicit delivery/outbox/reminder relations/functions and associated INSERT sequence USAGE | No issuer API, control-ledger DML, DDL/TEMP, ownership, grant option, administrative attributes or role membership |

`sql031Permissions.js` is the executable manifest. It validates PostgreSQL catalog
observations, not role names or JavaScript labels. `distinctLogins` rejects shared
identities. `session_user` must equal `current_user`. Any reachable membership is
rejected in this foundation (even NOINHERIT membership can permit SET ROLE).
Prepared-schema checks require an exclusive local test database and actual executor
permissions, in addition to the existing migration checksum checks.

The existing issuer transaction runner reuses the exact original identity checks;
its COMMIT knowledge, UNKNOWN behavior, local-test-only restrictions and authority
provenance are unchanged. The complete manifest validator is also exercised against
all three real logins in the new permission fixture. This does not silently activate
the SQL031 adapter in supervisor startup.

## Why each executor grant exists

| Grant group | Actual code need |
| --- | --- |
| schema_migrations SELECT | preparedSchema.verifyPreparedSchema checksum inspection |
| evolution_executors SELECT | executionLifecycle.registerExecution identity lookup; supervised birth is issuer-owned |
| evolution_operation_executions SELECT/INSERT | executionLifecycle.registerExecution and checkAuthorization |
| evolution_execution_authorizations SELECT/INSERT/UPDATE | 030 registration trigger, checkAuthorization renewal/revoke and atomic finalization |
| authorization/lifecycle views SELECT | delivery recovery and lifecycle inspection; no STOP writes |
| evolution_instance_owners SELECT/UPDATE; ownership_models SELECT | ownership resolver, operation reserve/release and registry validation |
| whatsapp_messages, appointment_reminders SELECT/INSERT/UPDATE | claim, dispatch frontier, finalization, materialization and recovery |
| evolution_delivery_reconciliations SELECT/INSERT | existing explicit internal reconciliation receipts |
| conversation relations SELECT/INSERT/UPDATE | conversationStore input/outbox correlation and pending-input processing |
| return_reminders SELECT/INSERT/UPDATE; return_reminder_delivery SELECT | existing return materialization and eligibility checks |
| appointment_reminder_origins SELECT/INSERT/UPDATE | reminder snapshot refresh, called by reminders.js |
| configuration, account, appointment, customer, service/professional relations SELECT | access, snapshots and eligibility used by these workers |
| lock_gate and lock_finalization EXECUTE | executionLifecycle and ownership operation acquire the certified SQL031 lock order |
| explicit ownership/reminder/return helper EXECUTE | SQL helper calls made by the existing delivery workers and invoker triggers |
| sequence USAGE for INSERT-capable tables | generated IDs for those inserts; no sequence SELECT/UPDATE |

This is a delivery-runtime profile, not certification of every SaaS HTTP mutation,
administrative route or payment workflow. Grants for those unrelated workflows are
not added merely to make an application boot test pass. No GRANT ALL is used.

## Validation and provisioning

Only the test helper provisions identities/grants. Before connecting it rejects
non-loopback URLs, non-test database names and connection-string options that could
redirect the connection. Each fixture creates randomized NOSUPERUSER/NOCREATEDB/
NOCREATEROLE/NOREPLICATION/NOBYPASSRLS/NOINHERIT logins and a disposable test_sql031_*
database. Existing test infrastructure supplies the provisioning administrator;
no runtime login is given provisioning authority. Teardown closes pools, drops the
fixture database/roles and checks their absence, including on test failure.

Schema/database CREATE, TEMP, role memberships, object ownership, effective table
and column privileges, grant options, function execution and sequence grants are
checked. Unknown accessible user objects/functions are rejected. Required grants
must be present as well as excessive grants absent. Catalog inspection is a startup
check, not a continuous defense against a trusted administrator changing ACLs later.

The runtime process test uses the actual fixed supervisor/bootstrap and restricted
executor login. Issuer enrollment/OPEN/DRAINING is local test composition only.
The child has no issuer/migrator credential; a parent's general DATABASE_URL and
unknown control secrets are excluded by the existing environment builder. The
supervision loadEnv guard is preserved. No child migration or SQL031 closure writer
is installed. Empty local worker startup and fake/local SQL operations do not call
Evolution, WhatsApp or Mercado Pago.

## Explicit remaining blockers

`persistentEmissionEnabled=false` and `3B_PERMISSION_SEPARATION_REQUIRED` remain.
There is no child seal → SQL031 closure → STOP integration. A child knows its HMAC
key, so authenticated claims are not proof of honest accounting. A seal ID cannot
be turned into manufactured zero counters. SQL login separation also does not
isolate a shared OS user, filesystem, process memory or accessible parent secrets.
Untrusted/native child code, OS credential isolation, complete remote-seal provenance
and later production provisioning remain separate work.

Exit, SIGTERM, SIGINT, timeout and IPC disconnect alone create no closure, stop proof
or STOPPED. SQL031's separate process-exit modality remains outside this composition.
No delivery semantics change: pre-frontier safe recovery, post-frontier uncertainty,
no unsafe retry, claim/token fencing, late descendants, reconciliation receipts and
atomic finalization/release remain as certified. Lifecycle STOP is not transport
acceptance and does not release reservations.

15-minute and 5-minute reminder activation remains PENDING. No real instance or
protected historical delivery is accessed by this foundation.

## Authorized validation gates

B1: new permission unit tests. B2: local PostgreSQL permission tests. B3: new
process tests and updated supervision runtime. B4: SQL031 authority/stop/adversarial
targeted regressions. B5: delivery finalization/unknown, ownership operation and
execution authorization/lifecycle sentinels. No full suite, commit, push or deploy.

## H1: system privilege inspection

The initial implementation excluded system namespaces from object inspection.
H1 adds an ACL excess query spanning all namespaces and all ACL-bearing relations,
columns, routines (including procedures), sequences, schemas and types. No namespace
is excluded from this check. Ownership/schema-CREATE checks also span every namespace.
The query expands actual ACLs with grantor/grantee/grant-option information and
uses effective role reachability. The separate MEMBER check rejects SET ROLE paths,
including NOINHERIT paths. Type ownership is rejected alongside relation/routine ownership.

The application manifest remains mandatory. Normal bootstrap PUBLIC rights are
recognized only for reserved bootstrap OIDs (<16384) in pg_catalog/information_schema.
Their baseline is pg_init_privs with privtype=i, falling back to acldefault when
initdb did not need a special ACL. In particular, acldefault('f') alone is NOT the
baseline for restricted server-file routines: pg_init_privs preserves their initial
PUBLIC revocations. Extension-installed/new objects do not receive this bootstrap
exception merely because they live in a system namespace. Manifest queries omit
bootstrap objects only because the all-namespace ACL check handles their excess rights.
Bootstrap information_schema relations also permit metadata SELECT: initdb does not
record those normal PUBLIC metadata grants in pg_init_privs on PostgreSQL 18.6.
This is a read-only object-class rule, not a general namespace exemption; writes,
grant options, ownership and new/non-bootstrap objects remain checked.

USAGE on schemas/types alone is permitted; CREATE, ownership and grant options are
not. A direct grant that merely duplicates an initial PUBLIC capability is harmless
unless it carries grant option. New effective privileges (including new PUBLIC grants
on initially restricted objects) and all reachable grant options are rejected.
ACL privilege names are examined directly, so extra rights are not silently lost
through a fixed privilege-name list. Existing sequence restrictions still apply.

The real PostgreSQL tests inject temporary ACL changes ONLY through a provisioning
connection to the disposable fixture database, never the infrastructure connection's
original database. They cover a restricted system function, a separate built-in
grant option, a system relation/column, schema CREATE, type grant option and an
additional PUBLIC grant. They inspect privileges without invoking restricted APIs,
reading protected system data, performing DML on catalogs or exploiting escalation.
Every injection is revoked in finally and the valid profile is checked again.
Existing role-membership negatives are retained rather than duplicated.

H1 does not change the issuer runner's legacy transaction contract, IPC, startup
entrypoints, delivery semantics or STOP integration. SQL/OS administrator tampering
with catalog contents or the trusted baseline is outside this ordinary-role model.
Linux validation and full suite remain separately authorized gates.

## H2B: complete administrative authority coverage

The profile is a startup snapshot of the connected database plus shared cluster
administrative authority. All reachable grant options are forbidden. Direct and
PUBLIC ACLs are expanded with grantor/grantee information; inherited effective
privileges use PostgreSQL role reachability. Any MEMBER path is independently
rejected, including a NOINHERIT path usable via SET ROLE. The profile requires
session_user=current_user and the original distinct login checks.

`excessAclSql` now includes database, tablespace, language, FDW, foreign server,
large-object metadata and parameter ACLs. Parameter ACLs are read from paracl,
not the relation ACL. `has_parameter_privilege` confirms effective capability.
ALTER SYSTEM and specially privileged SET are forbidden. Ordinary user-context
SET is redundant and permitted without grant option. No setting value is read
or changed by the validator. No ALTER SYSTEM, reload or restart is performed.

CONNECT is permitted; CREATE, TEMP and database ownership are forbidden. The
supervised delivery runtime needs no temporary relations or arbitrary DDL. Its
ordinary INSERT/claim/finalization capabilities remain required and tested.
Tablespace CREATE/ownership/delegation is rejected even though other controls
also block table creation. No real tablespace is created or altered by tests.

Trusted procedural-language USAGE is a normal baseline. Untrusted languages do
not receive synthetic PUBLIC USAGE from acldefault: PostgreSQL requires a
superuser to create functions in them, and superuser runtime logins are rejected.
Any real additional untrusted-language ACL, language ownership or grant option
is inspected/rejected. SQL wrappers cannot bypass the routine manifest.

FDW/server USAGE, ownership and delegation are outside the runtime. User mapping
inspection uses only the public metadata view's role/server identifiers, never
umoptions or connection credentials. Mappings count as usable authority only
with effective server USAGE. No CREATE SERVER or external access is performed.
Native foreign-server/mapping creation tests are deliberately not executed under
that prohibition; generic rejection inputs and the same ACL/ownership mechanism
are covered by unit tests and real FDW/large-object cases. FDW ownership cannot
be assigned to a non-superuser by PostgreSQL; the test proves this denial without
ever elevating the executor.

Large objects are not used by this delivery runtime. Their metadata ACLs and
ownership are rejected without accessing payloads. Startup also rejects access
to PostgreSQL's internal large-object allocation entrypoints, including aliases:
otherwise default PUBLIC allocator execution could create persistent owned
objects after validation. The small allocation capability group is defined by
internal entrypoints, not fixture object names. Only the disposable fixture DB
revokes those PUBLIC grants; no production grants are applied by this change.
Other normal PUBLIC builtins remain accepted. An administrator creates/unlinks
an empty local object solely to test metadata grants/ownership; the executor
never invokes the granted operation or reads/writes its content.

Ownership is checked both on each audited ACL-bearing object and generically
through pg_shdepend owner dependencies, for this database and shared objects.
This covers extensions, publications/subscriptions, collations, conversions,
operators/classes/families, text search, statistics and event triggers without
reading protected subscription/connection data. Own pg_default_acl metadata is
exempt: changing one's harmless future defaults grants no capability to create
an object or alter somebody else's defaults. Actual instantiated grants are
checked, and arbitrary database/schema CREATE and ownership remain forbidden.

### Authority matrix after H2B

| Category | Status / threat | Code coverage | Test coverage | Baseline | Residual risk |
| --- | --- | --- | --- | --- | --- |
| DATABASE | COVERED: DDL/delegation | identitySql + database ACL/owner | CREATE, TEMP, CONNECT grant option, owner denial | CONNECT; no TEMP needed | Other databases' per-object ACLs are outside this connected-DB snapshot; shared ownership is checked |
| TABLESPACE | COVERED: storage structure | tablespace ACL + owner | real pg_default CREATE/grant option; generic owner inputs | No CREATE | No filesystem tablespace/owner mutation fixture |
| LANGUAGE | COVERED: structural/delegation | language trust + ACL + owner | PUBLIC plpgsql accepted; grant option denied; generic owner inputs | Trusted USAGE | Untrusted function creation additionally requires rejected superuser authority |
| FDW | COVERED: arbitrary server creation | fdwacl/fdwowner | handler-free random dummy grants; PostgreSQL denies non-superuser owner | None | No handler/access invoked |
| FOREIGN SERVER | COVERED: external path | srvacl/srvowner + usable mapping metadata | generic unit inputs; shared native mechanism tested on FDW/LO | None | Native server/mapping creation not executed because prohibited |
| LARGE OBJECT | COVERED: off-manifest persistence/data | lomacl/lomowner + allocator capability | empty object SELECT/UPDATE/grant option/owner; allocator PUBLIC denial | No allocator or existing object access | No payload read/write |
| PARAMETER | COVERED: persistent config/special SET | paracl + has_parameter_privilege | SET, ALTER SYSTEM, both grant options, effective inherited, PUBLIC | Ordinary user-context SET only | No capacity exercised |
| SCHEMA | COVERED: DDL | all-namespace CREATE/owner + ACL | H1 + prior negatives | USAGE | Startup snapshot |
| RELATION | COVERED: off-manifest data/structure | native grants + ACL manifest | H1 system and control-ledger DML negatives | Operational manifest/bootstrap metadata reads | Startup snapshot |
| COLUMN | COVERED: partial grants/delegation | attribute ACL expansion | H1 column and grant-option cases | Manifest rights | Startup snapshot |
| SEQUENCE | COVERED: off-manifest allocation | native sequence checks + ACL | operational IDs + unit excess | USAGE only on INSERT-capable tables | Startup snapshot |
| FUNCTION/PROCEDURE | COVERED: privileged execution | routine manifest/system baseline/ACL | H1 + authority/adversarial | Initial safe PUBLIC + operational APIs | Trusted catalog baseline |
| TYPE | COVERED: structural/delegation | type ACL/owner | H1 grant option and ownership inputs | USAGE | Startup snapshot |
| ROLE | COVERED: escalation | administrative flags, MEMBER, identity | prior negatives + effective parameter inheritance | Own ordinary login behavior | OS isolation separate |
| OWNERSHIP | COVERED: administrative control | per-class owner + generic pg_shdepend | real database and empty LO; generic class inputs | No operational object owner | Trusted administrator catalog tampering excluded |
| DEFAULT PRIVILEGES | SAFE BY DEFAULT — justified | actual object grants inspected; only own default metadata ownership exempt | reducing own PUBLIC function defaults remains valid | Harmless own future defaults | Later administrative DDL/ACL changes require revalidation |

### Isolated cluster and cleanup

These fixtures now require test-only SQL031_ISOLATED_CLUSTER_DIR and
SQL031_ISOLATED_CLUSTER_ID. The provisioning login confirms data_directory and
pg_control_system().system_identifier, PostgreSQL 18, loopback test_* URL and
absence of non-test databases before creating fixture roles/databases. These
variables do not activate production or cross the child environment allowlist.
H2B is run on a newly initialized private Windows PostgreSQL cluster, not the
previous server. Shared parameter/tablespace/PUBLIC ACL mutations are confined
to that cluster. Each grant is revoked in finally; native validity is checked
again; databases/roles/dummy objects are removed. Teardown verifies the unchanged
SHA256 of postgresql.auto.conf without printing its contents. The auxiliary
cluster is stopped after validation. No lifecycle scripts/dependencies, Linux,
full suite, commit, push or deployment belong to H2B.

This is not continuous monitoring or attestation of hostile JavaScript/OS code.
An administrative change after startup requires a new validation. The complete
positive IPC→SQL031 closure→STOP flow, OS isolation and remote seal provenance
remain pending; 3B_PERMISSION_SEPARATION_REQUIRED remains unchanged.
