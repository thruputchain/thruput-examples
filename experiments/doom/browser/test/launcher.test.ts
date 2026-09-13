import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';

test('interrupted funding resumes the deployed contract and serves only static files', {timeout: 30000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'doom-launcher-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const app = join(root,'browser'), data = join(root,'data');
  for (const path of ['browser/scripts','browser/dist','build','vendor/PureDOOM']) await mkdir(join(root,path),{recursive:true});
  await copyFile(resolve('scripts/run-node.mjs'),join(app,'scripts/run-node.mjs'));
  await copyFile(resolve('dist/game.mjs'),join(app,'dist/game.mjs'));
  await writeFile(join(app,'dist/app.js'),'// fixture app');
  await writeFile(join(app,'dist/index.html'),'<canvas></canvas>');
  await writeFile(join(root,'build/doom.rv32a'),'fixture artifact');
  await writeFile(join(root,'vendor/PureDOOM/doom1.wad'),'fixture WAD');
  const cli = join(root,'groundhog-fixture');
  await writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('groundhog 0.16.1'); process.exit(0); }
const dir = path.dirname(process.env.XDG_CONFIG_HOME);
fs.mkdirSync(dir,{recursive:true});
fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify(args)+'\\n');
const ok = data => console.log(JSON.stringify({ok:true,data}));
if (args[1] === 'node') {
 const manifest = path.join(dir,'runtime.json');
 fs.writeFileSync(manifest,JSON.stringify({networkHash:'11'.repeat(32)}));
 ok({rpc_url:'http://127.0.0.1:9545',runtime_manifest:{path:manifest}});
 setInterval(()=>{},1000);
} else if (args[1] === 'deploy') ok({address:'0x'+'22'.repeat(32)});
else if (args[1] === 'transfer') {
 const marker = path.join(dir,'first-transfer-failed');
 if (!fs.existsSync(marker)) { fs.writeFileSync(marker,'1'); process.exit(1); }
 ok({});
} else process.exit(2);
`);
  await chmod(cli,0o755);
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0,'127.0.0.1',resolve));
  const port = (reservation.address() as {port:number}).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  function launch() {
    const child = spawn(process.execPath,[join(app,'scripts/run-node.mjs'),'--groundhog',cli,'--data-dir',data,'--port',String(port)],{stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',bytes=>{output+=bytes}); child.stderr.on('data',bytes=>{output+=bytes});
    const exit = new Promise<number | null>(resolve => child.once('exit',resolve));
    t.after(async () => { if (child.exitCode===null && child.signalCode===null) { child.kill('SIGTERM'); await exit; } });
    return {child,exit,output:()=>output};
  }
  const first = launch();
  assert.equal(await first.exit,1);
  const interrupted = JSON.parse(await readFile(join(data,'browser-session.json'),'utf8'));
  assert.equal(interrupted.contract,'0x'+'22'.repeat(32));
  assert.equal(interrupted.contractFunded,false);
  const second = launch();
  const deadline = Date.now()+10000;
  while (!second.output().includes('Play at')) {
    if (second.child.exitCode!==null || Date.now()>deadline) throw new Error(second.output());
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  const config = await (await fetch(`http://127.0.0.1:${port}/config.json`)).json();
  assert.equal(config.contract,interrupted.contract);
  assert.equal(config.rpcUrl,'http://127.0.0.1:9545');
  assert.equal((await fetch(`http://127.0.0.1:${port}/step`,{method:'POST'})).status,405);
  const funded = JSON.parse(await readFile(join(data,'browser-session.json'),'utf8'));
  assert.equal(funded.contractFunded,true); assert.equal(funded.signerFunded,true);
  const calls = (await readFile(join(data,'calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.filter(args=>args[1]==='deploy').length,1);
  assert.equal(calls.filter(args=>args[1]==='transfer').length,3);
  second.child.kill('SIGTERM'); await second.exit;
});
