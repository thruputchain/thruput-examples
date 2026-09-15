import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("./", import.meta.url));
const source = path.resolve(root, "../wallet-extension/dist");
const output = path.join(root, "dist");
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
if (!manifest.host_permissions.includes("https://rpc.thruput.network/*"))
  throw new Error("Rebuild the wallet with current Devnet permissions");
const files = {};
async function collect(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collect(filename, name);
    else if (entry.isFile()) {
      files[name] = [await readFile(filename), { mtime: new Date("2026-01-01T00:00:00Z") }];
    } else throw new Error(`Unsupported wallet build entry: ${entry.name}`);
  }
}
for (const required of ["worker.js", "content.js", "inpage.js", "index.html"])
  await readFile(path.join(source, required));
await collect(source, "thruput-wallet");
const archive = zipSync(files, { level: 9 });
const sha256 = createHash("sha256").update(archive).digest("hex");
const filename = `thruput-wallet-${manifest.version}-${sha256.slice(0, 12)}.zip`;
await mkdir(output, { recursive: true });
await writeFile(path.join(output, filename), archive);
await writeFile(path.join(output, "SHA256SUMS"), `${sha256}  ${filename}\n`);
await writeFile(path.join(output, "release.json"), JSON.stringify({
  version: manifest.version, filename, sha256, bytes: archive.length,
}, null, 2) + "\n");
console.log(`Packaged ${filename} (${archive.length} bytes)`);
