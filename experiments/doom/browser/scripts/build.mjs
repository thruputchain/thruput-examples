import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', {recursive: true});
await build({entryPoints: ['src/main.ts'], outfile: 'dist/app.js', bundle: true,
  format: 'esm', platform: 'browser', target: 'es2022', minify: true});
// The launcher and benchmark use the same client implementation as the browser.
await build({entryPoints: ['src/game.ts'], outfile: 'dist/game.mjs', bundle: true,
  format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], conditions: ['import'], target: 'es2022'});
await copyFile('index.html', 'dist/index.html');
