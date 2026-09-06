import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGroundhogRegistrySource } from "./chain.ts";
import { loadServerConfig, ServerConfigurationError } from "./config.ts";
import { createRegistryHttpServer } from "./http.ts";
import { RegistryIndexer } from "./indexer.ts";
import {
  PUBLIC_CONFIG_MANIFEST_FILENAME,
  PublicConfigManifestError,
  verifyPublicConfigManifest,
} from "./public-config-manifest.ts";
import { RegistryStore } from "./store.ts";

interface ShutdownResources {
  indexer: { stop(): Promise<void> };
  server: { close(callback: (error?: Error) => void): unknown };
  store: { close(): void };
}

interface ShutdownSignalTarget {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exitCode: string | number | null | undefined;
}

export async function start(): Promise<void> {
  const config = loadServerConfig(process.env);
  const staticDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist",
  );
  await verifyPublicConfigManifest(
    path.join(staticDirectory, PUBLIC_CONFIG_MANIFEST_FILENAME),
    process.env,
  );
  if (!(await stat(path.join(staticDirectory, "index.html"))).isFile()) {
    throw new Error("Production index.html is missing");
  }

  // Verify the configured source before creating or opening deployment state.
  const source = await createGroundhogRegistrySource(config);
  await mkdir(path.dirname(config.databasePath), { recursive: true });
  const store = new RegistryStore(config.databasePath, config.scope);
  const indexer = new RegistryIndexer(store, source, {
    pageSize: config.pageSize,
    syncIntervalMs: config.syncIntervalMs,
  });
  const server = createRegistryHttpServer(store, indexer, {
    staticDirectory,
    rpcUrl: config.rpcUrl,
    // Railway identifies the client remote IP through X-Real-IP.
    trustedProxy: process.env.RAILWAY_ENVIRONMENT_ID !== undefined,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }

  indexer.start();
  console.log(
    `Pool registry listening on port ${config.port}; network=${summary(config.scope.networkId)} factory=${summary(config.scope.factoryAddress)}`,
  );

  const stop = createGracefulShutdown({ indexer, server, store });
  registerShutdownSignals(stop);
}

export function createGracefulShutdown({
  indexer,
  server,
  store,
}: ShutdownResources): () => Promise<void> {
  let stopping: Promise<void> | null = null;
  return function stop(): Promise<void> {
    stopping ??= (async () => {
      let failure: unknown;
      try {
        await indexer.stop();
      } catch (error) {
        failure = error;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        });
      } catch (error) {
        failure ??= error;
      }
      try {
        store.close();
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    })();
    return stopping;
  };
}

export function registerShutdownSignals(
  stop: () => Promise<void>,
  target: ShutdownSignalTarget = process,
  reportFailure: (message: string) => void = console.error,
): void {
  const handleSignal = (): void => {
    void stop().catch(() => {
      reportFailure("Graceful shutdown failed");
      target.exitCode = 1;
    });
  };

  target.once("SIGINT", handleSignal);
  target.once("SIGTERM", handleSignal);
}

export function startupFailureMessage(error: unknown): string {
  const prefix = "Pool registry failed to start";
  return error instanceof PublicConfigManifestError ||
    error instanceof ServerConfigurationError
    ? `${prefix}: ${error.message}`
    : prefix;
}

export function reportStartupFailure(
  error: unknown,
  report: (message: string) => void = console.error,
): void {
  report(startupFailureMessage(error));
}

if (isExecutable(import.meta.url, process.argv[1])) {
  void start().catch((error: unknown) => {
    reportStartupFailure(error);
    process.exitCode = 1;
  });
}

function summary(value: string): string {
  return `${value.slice(0, 14)}...`;
}

function isExecutable(
  moduleUrl: string,
  entrypoint: string | undefined,
): boolean {
  return (
    entrypoint !== undefined &&
    fileURLToPath(moduleUrl) === path.resolve(entrypoint)
  );
}
