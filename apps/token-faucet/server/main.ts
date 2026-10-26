import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler, json } from "./http";
import { startFaucet } from "./runtime";

const runtime = await startFaucet(process.env);
const api = createApiHandler(runtime.config, runtime.claims);
const root = fileURLToPath(new URL("../dist", import.meta.url));
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = createServer((request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  void (async () => {
    if (await api(request, response)) return;
    if (request.method !== "GET" && request.method !== "HEAD") {
      json(response, 405, { error: "GET is required." });
      return;
    }
    const path = decodeURIComponent(
      new URL(request.url || "/", "http://localhost").pathname,
    );
    const file = resolve(root, `.${extname(path) ? path : "/index.html"}`);
    if (
      !file.startsWith(root + sep) ||
      !mime[extname(file)] ||
      !(await stat(file)).isFile()
    ) {
      json(response, 404, { error: "Not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": mime[extname(file)]!,
      "Cache-Control": path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    if (request.method === "HEAD") response.end();
    else
      createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
  })().catch(() => {
    if (!response.headersSent) json(response, 404, { error: "Not found." });
    else response.destroy();
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(runtime.config.port, runtime.config.host, () =>
  console.log(`Token Faucet listening on port ${runtime.config.port}`),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void runtime.close();
  });
  server.closeIdleConnections();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
