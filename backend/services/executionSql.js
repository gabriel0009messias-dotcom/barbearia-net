const { executionScope } = require('./executionScope');

// The caller's deadline and the server operation have separate lifetimes.
// No retry, outcome inference, cancellation attestation or UNKNOWN recovery.
function createSqlAccounting(scope = executionScope) {
  function run(kind, work) {
    const snapshot = scope.snapshot();
    // Legacy diagnostic reads after an unsealed 3A drain retain their contract.
    // A certifiable boot never uses this compatibility branch.
    if (!snapshot.certifiable && snapshot.state !== 'OPEN' && !scope.hasTask()) return Promise.resolve().then(work);
    return scope.hasTask() ? scope.follow(kind, work) : scope.admit(kind, work);
  }
  function observe(kind, work) {
    if (!scope.snapshot().certifiable && scope.snapshot().state !== 'OPEN' && !scope.hasTask()) {
      return Promise.resolve().then(() => work({ unknown: reason => scope.blockCertification(reason) }));
    }
    return run(kind, async () => {
      const obligation = scope.obligation(kind);
      try { return await work(obligation); }
      finally { obligation.finish(); }
    });
  }
  const uncertain = error => !/^[0-9A-Z]{5}$/.test(error?.code || '') || /^08|^57P0/.test(error.code);
  function wrapPool(rawPool) {
    if (rawPool.options?.pipeline) scope.blockCertification('UNSUPPORTED_SQL_PIPELINE');
    function wrapClient(raw, release) {
      let released = false, transaction, commitUnknown = false;
      const inFlight = new Set();
      const legacyCleanup = !scope.snapshot().certifiable && scope.snapshot().state !== 'OPEN' && !scope.hasTask();
      const borrow = legacyCleanup ? undefined : scope.obligation('sql.borrow');
      const defaultTimeout = raw.connectionParameters?.query_timeout || 0;
      if (raw.connectionParameters) raw.connectionParameters.query_timeout = 0;
      const proxy = new Proxy(raw, { get(target, property) {
        if (property === 'release') return (...args) => {
          if (released) return;
          released = true;
          const complete = () => {
            if (transaction) { transaction.unknown(); transaction.finish(); args = [true]; }
            borrow?.finish();
            return (release || target.release.bind(target))(...args);
          };
          if (!inFlight.size) return complete();
          Promise.all([...inFlight]).then(complete).catch(() => scope.blockCertification('SQL_RELEASE_FAILED'));
        };
        if (property === 'query') return (...args) => {
          if (released) return Promise.reject(Error('Borrowed SQL connection was released.'));
          const callback = typeof args.at(-1) === 'function' ? scope.bindCallback(args.pop()) : undefined;
          const input = args[0];
          if (typeof input !== 'string' && (!input || typeof input.text !== 'string')) {
            scope.blockCertification('UNACCOUNTED_SQL_QUERY_INTERFACE');
            throw Error('Unsupported SQL query interface.');
          }
          const config = typeof input === 'string' ? { text: input, values: args[1] } : { ...input };
          if (args[1] !== undefined) config.values = args[1];
          const timeoutMs = config.query_timeout || defaultTimeout;
          config.query_timeout = 0; // Never let pg replace the real completion callback.
          const command = config.text.trim().split(/\s+/)[0].replace(/;$/, '').toUpperCase();
          const actual = observe('sql.query', async obligation => {
            if (command === 'BEGIN' && !transaction) transaction = scope.obligation('sql.transaction');
            let value;
            try {
              value = await new Promise((resolve, reject) => target.query(config, (error, result) => {
                if (!error) { resolve(result); return; }
                // pg may deliver ErrorResponse before ReadyForQuery. A known
                // server error still needs the protocol's transaction boundary.
                if (!uncertain(error) && target.readyForQuery === false && target.connection) {
                  const cleanup = () => { target.connection.removeListener('readyForQuery', ready); target.removeListener('error', failed); target.removeListener('end', ended); };
                  const ready = () => { cleanup(); reject(error); };
                  const failed = cause => { cleanup(); reject(cause); };
                  const ended = () => failed(Object.assign(Error('SQL completion not confirmed'), { code: '08006' }));
                  target.connection.once('readyForQuery', ready); target.once('error', failed); target.once('end', ended);
                } else reject(error);
              }));
              const status = target.getTransactionStatus?.();
              if (status === 'I' || (!status && (command === 'COMMIT' || command === 'ROLLBACK'))) {
                transaction?.finish(); transaction = undefined;
              } else if ((status === 'T' || status === 'E') && !transaction) transaction = scope.obligation('sql.transaction');
              if (!status) scope.blockCertification('SQL_TRANSACTION_STATUS_UNAVAILABLE');
            } catch (error) {
              if (uncertain(error)) {
                obligation.unknown();
                transaction?.unknown();
                if (command === 'COMMIT') commitUnknown = true;
                scope.blockCertification('CERTIFICATION_BLOCKED_UNKNOWN_SQL');
              }
              if (command === 'BEGIN' && !uncertain(error)) { transaction?.finish(); transaction = undefined; }
              if (!uncertain(error) && target.getTransactionStatus?.() === 'I') { transaction?.finish(); transaction = undefined; }
              throw error;
            }
            // A later ROLLBACK/COMMIT cannot erase an earlier ambiguous COMMIT.
            if (commitUnknown) scope.blockCertification('CERTIFICATION_BLOCKED_UNKNOWN_SQL');
            return value;
          });
          const completion = actual.then(() => {}, () => {});
          inFlight.add(completion); completion.then(() => inFlight.delete(completion));
          let timer;
          const caller = timeoutMs > 0 ? Promise.race([actual, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(Error('Query read timeout'), { code: 'SQL_CALLER_TIMEOUT' })), timeoutMs);
          })]).finally(() => clearTimeout(timer)) : actual;
          Object.defineProperty(caller, 'sqlCompletion', { value: completion });
          if (!callback) return caller;
          // Register before the driver starts/completes, retaining the callback too.
          run('sql.callback', async () => {
            let result, error;
            try { result = await caller; } catch (cause) { error = cause; }
            return callback(error, result);
          }).catch(() => scope.blockCertification('SQL_CALLBACK_FAILED'));
          return undefined;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return proxy;
    }
    const pool = new Proxy(rawPool, { get(target, property) {
      if (property === 'connect') return callback => {
        if (callback) callback = scope.bindCallback(callback);
        const actual = observe('sql.connection', async () => {
          try { return wrapClient(await target.connect()); }
          catch (error) { scope.blockCertification('CERTIFICATION_BLOCKED_UNKNOWN_SQL'); throw error; }
        });
        if (!callback) return actual;
        run('sql.connection-callback', async () => {
          let client, error;
          try { client = await actual; } catch (cause) { error = cause; }
          return callback(error, client, client && client.release);
        }).catch(() => scope.blockCertification('SQL_CALLBACK_FAILED'));
        return undefined;
      };
      if (property === 'query') return (...args) => {
        const callback = typeof args.at(-1) === 'function' ? scope.bindCallback(args.pop()) : undefined;
        const supplied = args[0];
        const timeoutMs = (typeof supplied === 'object' && supplied?.query_timeout) || target.options?.query_timeout || 0;
        if (typeof supplied === 'object' && supplied) args[0] = { ...supplied, query_timeout: 0 };
        const actual = run('sql.autocommit', async () => {
          const client = await pool.connect();
          let query;
          try { query = client.query(...args); return await query; }
          finally { await query?.sqlCompletion; client.release(); }
        });
        let timer;
        const caller = timeoutMs > 0 ? Promise.race([actual, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(Error('Query read timeout'), { code: 'SQL_CALLER_TIMEOUT' })), timeoutMs);
        })]).finally(() => clearTimeout(timer)) : actual;
        if (!callback) return caller;
        run('sql.pool-callback', async () => {
          let value, error;
          try { value = await caller; } catch (cause) { error = cause; }
          return callback(error, value);
        }).catch(() => scope.blockCertification('SQL_CALLBACK_FAILED'));
        return undefined;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return pool;
  }
  return Object.freeze({ wrapPool, run, bindCallback: scope.bindCallback });
}
const accounting = createSqlAccounting();
module.exports = { createSqlAccounting, accounting };
