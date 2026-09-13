import { DoomGame, type DemoConfig, type Frame, type PendingTransaction } from './game.ts';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const context = canvas.getContext('2d')!;
const image = context.createImageData(320, 200);
const play = document.querySelector<HTMLButtonElement>('#play')!;
const single = document.querySelector<HTMLButtonElement>('#step')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
const error = document.querySelector<HTMLElement>('#error')!;
const held = new Set<string>();
const mapping: Record<string, number> = {
  ArrowUp: 0xad, ArrowDown: 0xaf, ArrowLeft: 0xac, ArrowRight: 0xae,
  ControlLeft: 0x9d, ControlRight: 0x9d, ShiftLeft: 0xb6, ShiftRight: 0xb6,
  AltLeft: 0xb8, AltRight: 0xb8, Space: 32, Enter: 13, Escape: 27, Tab: 9,
  Comma: 44, Period: 46, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52,
  Digit5: 53, Digit6: 54, Digit7: 55,
};
let game: DoomGame;
let frame: Frame;
let running = false;
let busy = false;
const samples: number[] = [];

function pause() { running = false; play.textContent = 'Play'; held.clear(); }
function draw(next: Frame) {
  frame = next;
  const pixels = frame.pixels;
  for (let i = 0; i < 64000; i++) {
    const palette = 64000 + pixels[i] * 3;
    image.data[i * 4] = pixels[palette];
    image.data[i * 4 + 1] = pixels[palette + 1];
    image.data[i * 4 + 2] = pixels[palette + 2];
    image.data[i * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

async function step() {
  if (busy || !frame) return;
  busy = true; single.disabled = true;
  const start = performance.now();
  const keys = new Uint8Array(32);
  for (const code of held) { const key = mapping[code]; if (key !== undefined) keys[key >> 3] |= 1 << (key & 7); }
  try {
    draw(await game.step(frame.tick, keys));
    samples.push(performance.now() - start);
    if (samples.length > 105) samples.shift();
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const transaction = game.samples.at(-1)!;
    stats.textContent = `Tick ${frame.tick} · Block ${frame.height} · ${transaction.transactionMs.toFixed(1)} ms tx · ${(1000 / mean).toFixed(1)} FPS capacity`;
  } catch (cause) {
    pause(); error.textContent = cause instanceof Error ? cause.message : String(cause);
    if (game.pending) {
      play.disabled = true;
      error.textContent += ` Pending transaction: ${game.pending.hash}. Reload to check its receipt; it will not be submitted again.`;
    } else {
      try { draw(await game.frame()); } catch { /* Keep the original failure visible. */ }
    }
  } finally { busy = false; single.disabled = Boolean(game.pending); }
}

async function loop() {
  const start = performance.now();
  if (running) await step();
  setTimeout(loop, Math.max(0, 1000 / 35 - (performance.now() - start)));
}

async function initialize(config: DemoConfig) {
  const key = `doom-pending:${config.networkHash}:${config.contract}`;
  game = await DoomGame.connect(config, pending => {
    if (pending) localStorage.setItem(key, JSON.stringify(pending));
    else localStorage.removeItem(key);
  });
  const saved = localStorage.getItem(key);
  if (saved) {
    stats.textContent = 'Checking the pending transaction…';
    await game.recover(JSON.parse(saved) as PendingTransaction);
  }
  const response = await fetch('/doom1.wad');
  if (!response.ok) throw new Error('Cannot load doom1.wad');
  await game.initialize(new Uint8Array(await response.arrayBuffer()), message => { stats.textContent = message; });
  draw(await game.frame());
  stats.textContent = `Tick ${frame.tick} · Block ${frame.height} · Ready`;
  play.disabled = false; single.disabled = false;
  play.onclick = () => { running = !running; play.textContent = running ? 'Pause' : 'Play'; error.textContent = ''; };
  single.onclick = step;
  loop();
}

window.addEventListener('keydown', event => {
  if (mapping[event.code] !== undefined) { event.preventDefault(); held.add(event.code); }
});
window.addEventListener('keyup', event => {
  held.delete(event.code); if (mapping[event.code] !== undefined) event.preventDefault();
});
window.addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

async function main() {
  const response = await fetch('/config.json');
  if (!response.ok) throw new Error('Cannot load the local node configuration');
  const config = await response.json() as DemoConfig;
  await navigator.locks.request(`doom:${config.networkHash}:${config.contract}`, {ifAvailable: true}, async lock => {
    if (!lock) throw new Error('This game is already open in another tab');
    await initialize(config);
    // The browser releases this lock when the tab closes or reloads.
    await new Promise<void>(() => {});
  });
}
main().catch(cause => { pause(); error.textContent = cause instanceof Error ? cause.message : String(cause); });
