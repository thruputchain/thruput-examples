import {readFile, writeFile} from 'node:fs/promises';
import {DoomGame} from '../dist/game.mjs';

const [configPath, wadPath, outputPath, count = '105'] = process.argv.slice(2);
if (!configPath || !wadPath || !outputPath || !/^\d+$/.test(count) || Number(count) < 1) {
  throw new Error('Usage: node scripts/benchmark.mjs config.json doom1.wad output.json [ticks=105]');
}
const config = JSON.parse(await readFile(configPath,'utf8'));
const game = await DoomGame.connect(config);
try {
  await game.initialize(new Uint8Array(await readFile(wadPath)), console.log);
  const initial = await game.frame();
  let frame = initial;
  const loops = [];
  for (let i = 0; i < Number(count); i++) {
    const keys = new Uint8Array(32), key = i < 20 ? 0xad : 0xae;
    keys[key >> 3] |= 1 << (key & 7);
    const start = performance.now();
    frame = await game.step(frame.tick, keys);
    loops.push(performance.now() - start);
    if (frame.tick !== initial.tick + i + 1) throw new Error('Unexpected committed tick');
  }
  if (Buffer.from(frame.pixels).equals(Buffer.from(initial.pixels))) throw new Error('Gameplay pixels did not change');
  let staleRejected = false;
  try { await game.step(frame.tick - 1, new Uint8Array(32)); }
  catch (error) { if (!game.pending && /failed/.test(error.message)) staleRejected = true; else throw error; }
  if (!staleRejected) throw new Error('Stale input was accepted');
  if ((await game.frame()).tick !== frame.tick) throw new Error('Rejected call changed the game');
  const samples = game.samples.filter(sample => sample.method === 2);
  const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const mean = loops.reduce((a,b)=>a+b,0)/loops.length;
  const summary = {ticks: loops.length, meanMs: mean, fps: 1000/mean, medianMs: median(loops),
    transactionMedianMs: median(samples.map(sample=>sample.transactionMs)),
    scope: 'Node.js runs the same TypeScript signing and WebSocket client as the browser; canvas/display excluded',
    checks: ['WAD upload and initialization','committed gameplay','changed pixels','stale input rejection','unchanged state after rejection']};
  await writeFile(outputPath, JSON.stringify({config, summary, loops, transactions: game.samples},null,2)+'\n');
  await writeFile(outputPath+'.initial.bin',initial.pixels);
  await writeFile(outputPath+'.final.bin',frame.pixels);
  console.log(JSON.stringify(summary,null,2));
} finally { game.close(); }
