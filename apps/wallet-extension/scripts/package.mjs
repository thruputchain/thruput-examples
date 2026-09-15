import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "dist");
const output = path.join(root, "artifacts");
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
if (!manifest.host_permissions.includes("https://rpc.thruput.network/*"))
  throw new Error("Rebuild the wallet with current Devnet permissions");

const files = {};
async function collect(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const filename = path.join(directory, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collect(filename, name);
    else if (entry.isFile()) {
      // ZIP stores local calendar fields, not a UTC timestamp.
      files[name] = [await readFile(filename), { mtime: new Date(2026, 0, 1) }];
    } else throw new Error(`Unsupported wallet build entry: ${entry.name}`);
  }
}

for (const required of ["worker.js", "content.js", "inpage.js", "index.html"])
  await readFile(path.join(source, required));
await collect(source, "thruput-wallet");
const archive = zipSync(files, { level: 9 });
const sha256 = createHash("sha256").update(archive).digest("hex");
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "thruput-wallet.zip"), archive);
await writeFile(path.join(output, "SHA256SUMS"), `${sha256}  thruput-wallet.zip\n`);
console.log(`Packaged Thruput Wallet ${manifest.version}: ${archive.length} bytes; SHA-256 ${sha256}`);
