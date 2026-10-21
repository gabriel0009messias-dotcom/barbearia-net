const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const admissionError = () => Object.assign(new Error('Executor admission is closed.'), { code: 'INSTANCE_ADMISSION_CLOSED' });

// Local structured accounting, NOT evidence of process death. No persistence,
// STOPPED, transport outcome, token release or recovery belongs to this module.
function createExecutionScope() {
  const storage = new AsyncLocalStorage(), tasks = new Map(), history = [], waiters = new Set();
  let state = 'OPEN', executor, draining = false;
  const describe = task => Object.freeze({
    taskId: task.id, parentTaskId: task.parent?.id || null, kind: task.kind,
    executorId: task.executorId, executionId: task.executionId,
    startedAt: task.startedAt, endedAt: task.endedAt || null,
    state: task.ownSettled ? 'WAITING_FOR_CHILDREN' : 'RUNNING',
  });
  const notify = () => {
    if (draining && tasks.size === 0) {
      state = 'CLOSED';
      for (const resolve of waiters) resolve(true);
      waiters.clear();
    }
  };
  const finish = task => {
    if (!task.ownSettled || task.children.size) return;
    task.endedAt = new Date().toISOString();
    history.push(Object.freeze({ ...describe(task), state: task.outcome }));
    if (history.length > 128) history.shift();
    tasks.delete(task.id); task.resolveCompletion();
    if (task.parent) { task.parent.children.delete(task); finish(task.parent); }
    notify();
  };
  const isOpen = () => state === 'OPEN' && (storage.getStore()?.canAdmit?.() ?? true);
  const assertOpen = () => {
    const parent = storage.getStore();
    if (!isOpen() || (parent && (parent.ownSettled || !tasks.has(parent.id)))) throw admissionError();
  };
  function track(kind, work, continuation, canAdmit) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(kind) || typeof work !== 'function') throw Error('Invalid execution task.');
    if (canAdmit !== undefined && typeof canAdmit !== 'function') throw Error('Invalid task admission guard.');
    const parent = storage.getStore();
    canAdmit = parent?.canAdmit || canAdmit;
    if (state === 'CLOSED' || (parent && (parent.ownSettled || !tasks.has(parent.id))) ||
        (state !== 'OPEN' && (!continuation || !parent)) ||
        (!continuation && canAdmit && !canAdmit())) return Promise.reject(admissionError());
    let resolveCompletion;
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const task = { id: randomUUID(), parent, kind, canAdmit, children: new Set(), ownSettled: false,
      executorId: parent?.executorId || executor?.executorId || null,
      executionId: parent?.executionId || null, startedAt: new Date().toISOString(), resolveCompletion };
    tasks.set(task.id, task); parent?.children.add(task);
    let body;
    try { body = storage.run(task, work); } catch (error) { body = Promise.reject(error); }
    // Return the original result/deadline behavior. Accounting outlives this
    // promise when a registered child survives a Promise.race or detached caller.
    const settle = outcome => { task.ownSettled = true; task.outcome = outcome; finish(task); };
    const result = Promise.resolve(body).then(value => { settle('FULFILLED'); return value; }, error => { settle('REJECTED'); throw error; });
    Object.defineProperty(result, 'completion', { value: completion });
    // Observed rejection for timer-started work; callers still receive rejection.
    result.catch(() => {});
    return result;
  }
  const beginDrain = () => { if (state === 'OPEN') state = 'DRAINING'; return state; };
  async function drain({ timeoutMs } = {}) {
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) throw Error('Invalid drain timeout.');
    beginDrain(); draining = true; notify();
    if (state === 'CLOSED') return Object.freeze({ drained: true, state });
    let timer, resolveWait;
    const done = new Promise(resolve => { resolveWait = resolve; waiters.add(resolve); });
    try {
      const drained = timeoutMs === undefined ? await done : await Promise.race([done,
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
      return Object.freeze({ drained, state });
    } finally { clearTimeout(timer); waiters.delete(resolveWait); }
  }
  function setExecutor(identity) {
    if (!identity?.executorId || !identity?.bootId || (executor &&
      (executor.executorId !== identity.executorId || executor.bootId !== identity.bootId))) throw Error('Executor identity mismatch.');
    executor = Object.freeze({ executorId: identity.executorId, bootId: identity.bootId });
    const task = storage.getStore(); if (task) task.executorId = executor.executorId;
  }
  function bindExecution(identity) {
    const task = storage.getStore();
    if (!task || task.ownSettled || (task.boundExecution && task.executionId !== identity.executionId)) throw Error('Execution task mismatch.');
    setExecutor(identity); task.executionId = identity.executionId; task.boundExecution = true;
  }
  return Object.freeze({
    admit: (kind, work) => track(kind, work, false),
    // Scheduler entry points are new roots, never children of an expired timer
    // creation context. OPEN is still mandatory; this cannot bypass shutdown.
    admitRoot: (kind, work, { canAdmit } = {}) => storage.run(undefined, () => track(kind, work, false, canAdmit)),
    follow: (kind, work) => track(kind, work, true),
    assertOpen, isOpen, beginDrain, drain, setExecutor, bindExecution,
    snapshot: () => Object.freeze({ state, activeCount: tasks.size, executor,
      tasks: Object.freeze([...tasks.values()].map(describe)), history: Object.freeze([...history]) }),
  });
}

const key = Symbol.for('studiofy.executionScope.process.v1');
if (!globalThis[key]) Object.defineProperty(globalThis, key, { value: createExecutionScope() });
module.exports = { createExecutionScope, executionScope: globalThis[key] };
