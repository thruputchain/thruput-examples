import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [root, publicDir, outDir] = process.argv.slice(2);
const require = createRequire(`${root}/package.json`);
const { build } = await import(pathToFileURL(require.resolve("vite")));
await build({
  root,
  mode: "production",
  publicDir,
  cacheDir: `${outDir}/../vite-cache`,
  build: { outDir, emptyOutDir: true },
});
