import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadServerConfig } from "./config.ts";
import { createApiHandler, json } from "./http.ts";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Serve the built app, with `index.html` for client-side routes. */
export function staticFiles(directory: string): RequestListener {
  const root = resolve(directory);
  return (request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, 405, { error: "GET is required." });
        return;
      }
      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
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
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.PORT ?? 5174);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const api = createApiHandler(loadServerConfig(process.env));
  const files = staticFiles(resolve(root, "dist"));
  const server = createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    void api(request, response)
      .then((handled) => {
        if (!handled) files(request, response);
      })
      .catch(() => json(response, 500, { error: "Server error." }));
  });
  server.listen(port, "0.0.0.0", () =>
    console.log(`Swap listening on port ${port}`),
  );
  const stop = () => {
    server.close();
    server.closeIdleConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
