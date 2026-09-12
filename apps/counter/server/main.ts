import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadServerConfig, type ServerConfig } from "./config";
import { handleApi, json } from "./http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createCounterServer(
  config: ServerConfig,
  directory = fileURLToPath(new URL("../dist", import.meta.url)),
) {
  return createServer((request, response) => {
    response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    response.setHeader("X-Content-Type-Options", "nosniff");
    void (async () => {
      if (await handleApi(request, response, config)) return;
      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, 405, { error: "GET is required." });
        return;
      }
      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
      const root = resolve(directory);
      const file = resolve(
        root,
        `.${pathname === "/" ? "/index.html" : pathname}`,
      );
      if (
        !file.startsWith(root + sep) ||
        !MIME[extname(file)] ||
        !(await stat(file)).isFile()
      ) {
        json(response, 404, { error: "Not found." });
        return;
      }
      response.writeHead(200, {
        "Content-Type": MIME[extname(file)]!,
        "Cache-Control": file.includes(`${sep}assets${sep}`)
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
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535.");
  const server = createCounterServer(loadServerConfig(process.env));
  server.listen(port, "0.0.0.0", () =>
    console.log(`Thruput Counter listening on port ${port}`),
  );
  const stop = () => {
    server.close();
    server.closeIdleConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
