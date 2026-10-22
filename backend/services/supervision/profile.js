// Cooperative containment of known APIs, not an OS sandbox for hostile code.
function installSingleProcessProfile() {
  const Module = require('node:module');
  function deny() { throw Object.assign(Error('Resource outside certified single-process profile.'), { code: 'SUPERVISION_PROFILE_DENIED' }); }
  const cp = require('node:child_process');
  for (const name of ['fork','spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[name] = deny;
  require('node:worker_threads').Worker = deny;
  require('node:cluster').fork = deny;
  Module.syncBuiltinESMExports();
  const load = Module._load;
  Module._load = function(request, ...args) {
    if (/^(?:@wppconnect-team\/wppconnect|puppeteer(?:-core)?)(?:\/|$)/.test(request)) return deny();
    return load.call(this, request, ...args);
  };
}
module.exports = { installSingleProcessProfile };
