import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const directory = new URL("./dist/", import.meta.url);
const release = JSON.parse(await readFile(new URL("release.json", directory), "utf8"));
if (!/^thruput-wallet-[0-9.]+-[a-f0-9]{12}\.zip$/.test(release.filename))
  throw new Error("Invalid wallet release filename");
const archive = await readFile(new URL(release.filename, directory));
if (createHash("sha256").update(archive).digest("hex") !== release.sha256)
  throw new Error("Wallet archive checksum mismatch");
const page = await readFile(new URL("./index.html", import.meta.url));
const checksums = Buffer.from(`${release.sha256}  ${release.filename}\n`);
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const pathname = new URL(request.url, "http://localhost").pathname;
  let body, type;
  if (pathname === "/") { body = page; type = "text/html; charset=utf-8"; }
  else if (pathname === "/healthz") { body = Buffer.from('{"status":"ok"}'); type = "application/json"; }
  else if (pathname === "/release.json") { body = Buffer.from(JSON.stringify(release)); type = "application/json"; }
  else if (pathname === "/SHA256SUMS") { body = checksums; type = "text/plain; charset=utf-8"; }
  else if (pathname === "/wallet.zip" || pathname === `/${release.filename}`) {
    body = archive; type = "application/zip";
    response.setHeader("Content-Disposition", `attachment; filename="${release.filename}"`);
  } else { response.writeHead(404).end("Not found"); return; }
  response.writeHead(200, {
    "Content-Type": type, "Content-Length": body.length,
    "Cache-Control": pathname === `/${release.filename}` ? "public, max-age=31536000, immutable" : "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : body);
});
server.listen(port, "0.0.0.0", () => console.log(`Wallet downloads listening on port ${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
