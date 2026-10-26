import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, type ServerConfig } from "./config";
import { createApiHandler, json } from "./http";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createVotingServer(
  config: ServerConfig,
  directory = fileURLToPath(new URL("../dist", import.meta.url)),
) {
  const api = createApiHandler(config);
  const root = resolve(directory);
  return createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    void (async () => {
      if (await api(request, response)) return;
      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, 405, { error: "GET is required." });
        return;
      }
      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
      if (pathname.startsWith("/api/") || pathname.startsWith("/thruput-rpc")) {
        json(response, 404, { error: "Not found." });
        return;
      }
      const file = resolve(
        root,
        `.${extname(pathname) ? pathname : "/index.html"}`,
      );
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
        "Cache-Control": pathname.startsWith("/assets/")
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
  const port = Number(process.env.PORT ?? 5176);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const server = createVotingServer(loadConfig(process.env));
  server.listen(port, "0.0.0.0", () =>
    console.log(`Voting listening on port ${port}`),
  );
  const stop = () => {
    server.close();
    server.closeIdleConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
