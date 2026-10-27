const { invalid, object, text } = require('./sql031Payloads');
const { distinctLogins, assertIssuerIdentity } = require('./sql031Permissions');

const runners = new WeakSet();
const AUTHORITIES = Object.freeze({ MIGRATOR: 'MIGRATOR', EXECUTOR: 'EXECUTOR', SUPERVISOR_PROOF_ISSUER: 'SUPERVISOR_PROOF_ISSUER' });
const login = v => text(v, /^[a-z_][a-z0-9_]{0,62}$/);
const known = e => e?.code === 'SQL031_INPUT_INVALID' || /^(22|23|28|3D|3F|40|42|55)[0-9A-Z]{3}$/.test(e?.code || '') || e?.code === '57014';
const identitySql = `SELECT session_user::text AS session_user, current_user::text AS current_user,
 current_database() AS database_name, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
 EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=$1 AND pg_has_role(session_user,n.nspowner,'MEMBER')) AS owns_schema,
 has_schema_privilege(session_user,$1,'CREATE') AS schema_create,
 EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(session_user,d.datdba,'MEMBER')) AS owns_database,
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
  AND c.relname IN ('evolution_supervisors','evolution_executor_birth_bindings','evolution_executor_gates',
   'evolution_executor_closure_events','evolution_execution_stop_proofs','evolution_execution_stops')
  AND has_table_privilege(session_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')) AS ledger_write,
 pg_has_role(session_user,$2,'MEMBER') AS migrator_member,
 pg_has_role(session_user,$3,'MEMBER') AS executor_member
 FROM pg_roles r WHERE r.rolname=session_user`;

// No pool creation, environment lookup, timers, migration or business scope import.
function createControlSqlRunner(options) {
  object(options, ['pool', 'authority', 'issuerLogin', 'migratorLogin', 'executorLogin', 'schema', 'database', 'localTestOnly']);
  if (options.authority !== AUTHORITIES.SUPERVISOR_PROOF_ISSUER || options.localTestOnly !== true || typeof options.pool?.connect !== 'function') throw invalid();
  const issuerLogin = login(options.issuerLogin), migratorLogin = login(options.migratorLogin), executorLogin = login(options.executorLogin);
  distinctLogins({ issuerLogin, migratorLogin, executorLogin });
  const schema = text(options.schema, /^test_[a-f0-9]{32}$/), database = text(options.database, /^test_sql031_[a-f0-9]{32}$/), pool = options.pool;
  const context = Object.freeze({ authority: options.authority, issuerLogin, schema, database, localTestOnly: true });
  let inFlight = false, pendingSql = 0, attempts = 0, confirmed = 0, knownFailures = 0, unknown = 0;
  const result = (outcome, code, value) => Object.freeze(value === undefined ? { outcome, code } : { outcome, value });
  const runner = Object.freeze({ context,
    snapshot: () => Object.freeze({ inFlight, pendingSql, attempts, confirmed, knownFailures, unresolvedSql: unknown,
      blocked: unknown > 0, blockers: Object.freeze(unknown ? ['CONTROL_SQL_UNKNOWN'] : []) }),
    async run(operation, { readOnly = false } = {}) {
      if (unknown) return result('UNKNOWN', 'CONTROL_SQL_UNKNOWN');
      if (inFlight) return result('KNOWN_FAILURE', 'CONTROL_SQL_BUSY');
      if (typeof operation !== 'function' || typeof readOnly !== 'boolean') throw invalid();
      inFlight = true; attempts++;
      let client, begun = false, committed = false, operationActive = false, uncertain = false;
      const query = async (sql, values) => {
        pendingSql++;
        try { return await client.query(sql, values); }
        catch (error) { if (!known(error)) uncertain = true; throw error; }
        finally { pendingSql--; }
      };
      try {
        client = await pool.connect();
        const cp = client.connectionParameters;
        if (!cp || !['127.0.0.1', 'localhost', '::1'].includes(cp.host) || cp.database !== database || cp.user !== issuerLogin || cp.query_timeout > 0) throw invalid();
        const started = await query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
        if (started.command !== 'BEGIN') throw Error('Unconfirmed transaction start.');
        begun = true;
        const { rows } = await query(identitySql, [schema, migratorLogin, executorLogin]);
        assertIssuerIdentity(rows, issuerLogin, database);
        operationActive = true;
        const value = await operation(Object.freeze({ query: (sql, values) => {
          if (!operationActive) throw invalid();
          const pending = query(sql, values); pending.catch(() => {}); return pending;
        }, schema }));
        operationActive = false;
        if (pendingSql || uncertain) throw Error('Unresolved control SQL.');
        const ended = await query('COMMIT');
        if (ended.command === 'ROLLBACK') throw invalid();
        if (ended.command !== 'COMMIT') throw Error('Unconfirmed COMMIT.');
        committed = true;
        confirmed++; return result('CONFIRMED', undefined, value);
      } catch (error) {
        let definite = !uncertain && known(error);
        if (begun && definite && !committed) {
          try { if ((await query('ROLLBACK')).command !== 'ROLLBACK') definite = false; }
          catch { definite = false; }
        }
        if (definite) { knownFailures++; return result('KNOWN_FAILURE', 'SQL031_REJECTED'); }
        unknown++; return result('UNKNOWN', 'CONTROL_SQL_UNKNOWN');
      } finally {
        // An ambiguous transaction is discarded, never retried or repaired by ROLLBACK.
        operationActive = false;
        try { client?.release(unknown > 0); } catch { /* COMMIT knowledge is unaffected by pool bookkeeping. */ }
        inFlight = false;
      }
    },
  });
  runners.add(runner); return runner;
}
module.exports = { AUTHORITIES, createControlSqlRunner, isControlSqlRunner: value => runners.has(value) };
