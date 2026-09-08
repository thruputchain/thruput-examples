import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createServer as netServer } from "node:net";
const [root, publicDir, cacheDir] = process.argv.slice(2);
const require = createRequire(`${root}/package.json`);
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
// Vite treats port 0 as its default; allocate an ephemeral port explicitly.
const socket = netServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const server = await createServer({
  root,
  mode: "wallet-acceptance",
  publicDir,
  cacheDir,
  server: { host: "127.0.0.1", port, strictPort: true, open: false },
});
await server.listen();
console.log(`ACCEPTANCE_ORIGIN=${server.resolvedUrls.local[0]}`);
