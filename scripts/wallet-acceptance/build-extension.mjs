import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [root, outDir] = process.argv.slice(2);
const require = createRequire(`${root}/package.json`);
const { build } = await import(pathToFileURL(require.resolve("vite")));
await build({
  root,
  configFile: false,
  envFile: false,
  cacheDir: `${outDir}/../extension-cache`,
  build: { outDir, emptyOutDir: true },
});
const esbuild = require("esbuild");
await Promise.all(
  ["worker", "content", "inpage"].map((name) =>
    esbuild.build({
      absWorkingDir: root,
      entryPoints: [`src/${name}.ts`],
      outfile: `${outDir}/${name}.js`,
      bundle: true,
      format: name === "worker" ? "esm" : "iife",
      platform: "browser",
      target: "chrome120",
      minify: true,
      legalComments: "none",
    }),
  ),
);
