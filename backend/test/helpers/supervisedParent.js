// Fixed local Linux signal fixture; never selected by npm start.
if (process.env.NODE_ENV !== 'test') throw Error('Local test fixture only.');
const { startSupervisor } = require('../../supervisor');
const delay = Number(process.argv[2] || 0);
const supervisor = startSupervisor({
  authority: { localTestOnly: true,
    enrollBirth: () => new Promise(resolve => setTimeout(resolve,delay)), openGate: async () => {}, beginDraining: async () => {} },
  environment: { NODE_ENV: 'test' }, heartbeatMs: 50, heartbeatTimeoutMs: 500, handshakeTimeoutMs: 10000,
  onEvent: event => console.log('PARENT ' + JSON.stringify(event)),
});
supervisor.child.stdout.pipe(process.stdout); supervisor.child.stderr.pipe(process.stderr);
supervisor.done.then(result => { console.log('DONE ' + JSON.stringify(result)); process.exitCode = result.exit?.code || 0; });
