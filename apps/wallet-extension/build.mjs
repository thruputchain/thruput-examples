import { build } from "esbuild";
await Promise.all(
  ["worker", "content", "inpage"].map((name) =>
    build({
      entryPoints: [`src/${name}.ts`],
      outfile: `dist/${name}.js`,
      bundle: true,
      format: name === "worker" ? "esm" : "iife",
      platform: "browser",
      target: "chrome120",
      minify: true,
      legalComments: "none",
    }),
  ),
);
