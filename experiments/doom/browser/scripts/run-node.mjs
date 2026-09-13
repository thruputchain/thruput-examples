import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, rename, open, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { demoAccount } from '../dist/game.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(root, 'browser/dist');
const execute = promisify(execFile);
const {values} = parseArgs({options: {
  groundhog: {type: 'string', default: process.env.GROUNDHOG_CLI || 'groundhog'},
  'hog-devnode': {type: 'string'}, contracts: {type: 'string'},
  'data-dir': {type: 'string', default: join(root, 'build/browser-node')},
  'rpc-port': {type: 'string', default: '9545'}, port: {type: 'string', default: '8765'},
  'worker-threads': {type: 'string', default: '2'}, help: {type: 'boolean'},
}});
if (values.help) {
  console.log('npm start -- [--groundhog PATH] [--hog-devnode PATH --contracts DIR] [--data-dir DIR] [--rpc-port 9545] [--port 8765] [--worker-threads 2]');
  process.exit(0);
}
function integer(name, maximum) {
  if (!/^\d+$/.test(values[name])) throw new Error(`--${name} must be a positive integer`);
  const n = Number(values[name]);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new Error(`--${name} must be between 1 and ${maximum}`);
  return n;
}
const port = integer('port', 65535), rpcPort = integer('rpc-port', 65535);
const workers = integer('worker-threads', 65535);
if (port === rpcPort) throw new Error('The app and RPC need different ports');
const cli = values.groundhog.includes('/') ? resolve(values.groundhog) : values.groundhog;
const version = (await execute(cli, ['--version'], {timeout: 10000})).stdout.trim();
const match = /^groundhog (\d+)\.(\d+)\.(\d+)(?: \(commit [^)]+\))?$/.exec(version);
const numbers = match?.slice(1).map(Number);
if (!numbers || (numbers[0] === 0 && (numbers[1] < 16 || (numbers[1] === 16 && numbers[2] < 1)))) {
  throw new Error(`Doom requires Groundhog CLI 0.16.1 or newer; found ${version}`);
}
const dataDir = resolve(values['data-dir']);
await access(join(app, 'app.js'));
await mkdir(dataDir, {recursive: true});
const env = {...process.env, XDG_CONFIG_HOME: join(dataDir, 'config'), XDG_CACHE_HOME: join(dataDir, 'cache'),
  DEFAULT_THREADPOOL_SIZE: String(workers)};
const nodeArgs = ['--json', 'node', '--data-dir', join(dataDir, 'chain'), '--port', String(rpcPort),
  '--dev-account-count', '1', '--dev-account-hog', '100000', '--ramdb-bytes', '512M', '--block-driver', 'instant',
  '--network-config', 'max_rv32_code_bytes=1M', '--network-config', 'max_rv32_memory_bytes=16M',
  '--network-config', 'max_contract_size_bytes=1M', '--network-config', 'max_bytestring_len=64000'];
if (values['hog-devnode']) nodeArgs.push('--hog-devnode-binary', resolve(values['hog-devnode']));
if (values.contracts) nodeArgs.push('--contract-artifacts-dir', resolve(values.contracts));
const log = await open(join(dataDir, 'node.log'), 'a');
const node = spawn(cli, nodeArgs, {env, stdio: ['ignore', 'pipe', log.fd], detached: true});
let server, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server?.close();
  if (node.pid && node.exitCode === null && node.signalCode === null) {
    process.kill(-node.pid, 'SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { process.kill(-node.pid, 'SIGKILL'); } catch {} resolve(); }, 40000);
      node.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  await log.close();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
try {
  const startup = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Node startup timed out; see '+join(dataDir,'node.log'))), 60000);
    node.once('error', error => { clearTimeout(timer); reject(error); });
    node.once('exit', () => { clearTimeout(timer); reject(new Error('Node exited during startup; see '+join(dataDir,'node.log'))); });
    node.stdout.on('data', bytes => {
      output += bytes;
      if (output.length > 1024 * 1024) { clearTimeout(timer); reject(new Error('Unexpected node startup output')); return; }
      try {
        const result = JSON.parse(output);
        clearTimeout(timer);
        if (!result.ok) reject(new Error(JSON.stringify(result)));
        else resolve(result.data);
      } catch (error) { if (!(error instanceof SyntaxError)) { clearTimeout(timer); reject(error); } }
    });
  });
  await writeFile(join(dataDir, 'startup.json'), JSON.stringify(startup, null, 2)+'\n');
  const manifest = JSON.parse(await readFile(startup.runtime_manifest.path, 'utf8'));
  const target = ['--profile', 'local', '--rpc-url', startup.rpc_url, '--runtime-manifest', startup.runtime_manifest.path];
  async function command(...args) {
    const {stdout} = await execute(cli, ['--json', ...args, ...target], {env, cwd: root, timeout: 120000, maxBuffer: 8*1024*1024});
    const result = JSON.parse(stdout);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.data;
  }
  const artifact = join(root, 'build/doom.rv32a');
  const wad = join(root, 'vendor/PureDOOM/doom1.wad');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const artifactSha256 = sha(await readFile(artifact)), wadSha256 = sha(await readFile(wad));
  const statePath = join(dataDir, 'browser-session.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state && (state.networkHash !== manifest.networkHash || state.artifactSha256 !== artifactSha256 || state.wadSha256 !== wadSha256)) {
    throw new Error('Saved demo uses a different network, artifact or WAD; choose a fresh --data-dir');
  }
  async function save() { await writeFile(statePath+'.tmp', JSON.stringify(state,null,2)+'\n'); await rename(statePath+'.tmp', statePath); }
  if (!state) {
    const deployed = await command('deploy', '--artifact', artifact, '--force');
    state = {contract: deployed.address, networkHash: manifest.networkHash, artifactSha256, wadSha256,
      contractFunded: false, signerFunded: false};
    await save();
  }
  // Funding is recorded independently of deployment so interrupted setup resumes.
  if (!state.contractFunded) { await command('transfer', state.contract, '10000', '--force'); state.contractFunded = true; await save(); }
  if (!state.signerFunded) {
    await command('transfer', '0x'+Buffer.from(demoAccount().address).toString('hex'), '100', '--force');
    state.signerFunded = true; await save();
  }
  const config = {rpcUrl: startup.rpc_url, contract: state.contract, networkHash: manifest.networkHash, artifactSha256, wadSha256};
  const staticFiles = new Map([['/', [join(app,'index.html'),'text/html; charset=utf-8']],
    ['/app.js', [join(app,'app.js'),'text/javascript; charset=utf-8']], ['/doom1.wad',[wad,'application/octet-stream']]]);
  server = createServer(async (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    const path = new URL(request.url,'http://localhost').pathname;
    try {
      if (path === '/config.json') {
        response.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
        response.end(JSON.stringify(config)); return;
      }
      const file = staticFiles.get(path);
      if (!file) { response.writeHead(404); response.end(); return; }
      const content = await readFile(file[0]);
      response.writeHead(200, {'Content-Type':file[1], 'Content-Length':content.length, 'Cache-Control':'no-store'});
      response.end(content);
    } catch { response.writeHead(500); response.end('Cannot read demo asset'); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolve); });
  console.log(`Play at http://127.0.0.1:${port} (${version})`);
  console.log('The browser uploads the WAD, signs game calls, and reads committed frames directly over WebSocket RPC.');
  node.once('exit', () => { if (!stopping) { console.error('Node stopped; see '+join(dataDir,'node.log')); process.exitCode = 1; void stop(); } });
} catch (error) { console.error(error); process.exitCode = 1; await stop(); }
