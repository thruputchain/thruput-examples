// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfigurationError } from "./config.ts";
import {
  createGracefulShutdown,
  registerShutdownSignals,
  reportStartupFailure,
  startupFailureMessage,
} from "./main.ts";
import {
  createPublicConfigManifest,
  PublicConfigManifestError,
  verifyPublicConfigManifest,
} from "./public-config-manifest.ts";

const environment = {
  VITE_GROUNDHOG_RPC_URL: "https://rpc.example.test/groundhog",
  VITE_GROUNDHOG_NETWORK_ID: `0x${"11".repeat(32)}`,
  VITE_GROUNDHOG_WALLET_ADDRESS: `0x${"22".repeat(32)}`,
  VITE_GROUNDHOG_WALLET_ENTRYPOINT: `0x${"33".repeat(8)}`,
  VITE_NATIVE_HOG_ADDRESS: `0x${"44".repeat(32)}`,
  VITE_KNOWN_TOKEN_ADDRESSES: `0x${"55".repeat(32)}`,
  VITE_SWAP_FACTORY_ADDRESS: `0x${"66".repeat(32)}`,
  VITE_SWAP_ROUTER_ADDRESS: `0x${"77".repeat(32)}`,
  VITE_POOL_REGISTRY_ENABLED: "true",
};

describe("production startup reporting", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("reports only safe configuration error classes with exact messages", () => {
    expect(
      startupFailureMessage(
        new ServerConfigurationError("PORT must be between 1 and 65535"),
      ),
    ).toBe("Pool registry failed to start: PORT must be between 1 and 65535");
    expect(
      startupFailureMessage(
        new PublicConfigManifestError(
          "Production public configuration manifest is missing or unreadable",
        ),
      ),
    ).toBe(
      "Pool registry failed to start: Production public configuration manifest is missing or unreadable",
    );
  });

  it("reports the mismatched environment key without either value", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "swap-main-"));
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify(createPublicConfigManifest(environment)),
    );
    const buildCanary = environment.VITE_SWAP_FACTORY_ADDRESS;
    const runtimeCanary = `0x${"88".repeat(32)}`;

    let error: unknown;
    try {
      await verifyPublicConfigManifest(manifestPath, {
        ...environment,
        VITE_SWAP_FACTORY_ADDRESS: runtimeCanary,
      });
    } catch (caught) {
      error = caught;
    }

    const report = vi.fn<(message: string) => void>();
    reportStartupFailure(error, report);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      "Pool registry failed to start: VITE_SWAP_FACTORY_ADDRESS does not match the production build manifest",
    );
    expect(report.mock.calls[0]?.[0]).not.toContain(buildCanary);
    expect(report.mock.calls[0]?.[0]).not.toContain(runtimeCanary);
  });

  it.each([
    new Error("source returned SECRET_SOURCE_BODY"),
    new Error("HTTP https://user:SECRET_URL@example.test/?token=SECRET"),
    new Error("database /data/SECRET_DATABASE.sqlite failed"),
    { message: "SECRET_NON_ERROR_OBJECT" },
    { name: "PublicConfigManifestError", message: "SECRET_SPOOFED_ERROR" },
    "SECRET_THROWN_VALUE",
  ])("suppresses arbitrary startup failure details %#", (error) => {
    const report = vi.fn<(message: string) => void>();
    reportStartupFailure(error, report);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      "Pool registry failed to start",
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("SECRET");
    expect(JSON.stringify(report.mock.calls)).not.toContain("/data/");
    expect(JSON.stringify(report.mock.calls)).not.toContain("https://");
  });
});

describe("graceful shutdown", () => {
  it("stops, aborts, and awaits the indexer before HTTP and SQLite", async () => {
    const events: string[] = [];
    const stop = createGracefulShutdown({
      indexer: {
        async stop() {
          events.push("indexer:stop", "indexer:abort");
          await Promise.resolve();
          events.push("indexer:await");
        },
      },
      server: {
        close(callback) {
          events.push("http:stop");
          queueMicrotask(() => {
            events.push("http:close");
            callback();
          });
        },
      },
      store: { close: () => events.push("sqlite:close") },
    });

    const first = stop();
    const second = stop();
    expect(second).toBe(first);
    await first;
    expect(events).toEqual([
      "indexer:stop",
      "indexer:abort",
      "indexer:await",
      "http:stop",
      "http:close",
      "sqlite:close",
    ]);
  });

  it("attempts later cleanup after failures and surfaces the first failure", async () => {
    const events: string[] = [];
    const indexerFailure = new Error("indexer failed");
    const stop = createGracefulShutdown({
      indexer: {
        async stop() {
          events.push("indexer:stop");
          throw indexerFailure;
        },
      },
      server: {
        close(callback) {
          events.push("http:close");
          callback(new Error("HTTP failed"));
        },
      },
      store: {
        close() {
          events.push("sqlite:close");
          throw new Error("SQLite failed");
        },
      },
    });

    await expect(stop()).rejects.toBe(indexerFailure);
    expect(events).toEqual(["indexer:stop", "http:close", "sqlite:close"]);
  });

  it("registers one shared idempotent handler for SIGINT and SIGTERM", async () => {
    const listeners = new Map<string, () => void>();
    const target = {
      exitCode: undefined as number | undefined,
      once(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.set(signal, listener);
      },
    };
    const resourceStop = vi.fn(async () => undefined);
    const stop = createGracefulShutdown({
      indexer: { stop: resourceStop },
      server: { close: (callback) => callback() },
      store: { close: vi.fn() },
    });

    registerShutdownSignals(stop, target);
    expect(listeners.get("SIGINT")).toBe(listeners.get("SIGTERM"));
    listeners.get("SIGINT")?.();
    listeners.get("SIGTERM")?.();
    await stop();
    expect(resourceStop).toHaveBeenCalledOnce();
    expect(target.exitCode).toBeUndefined();
  });

  it("marks a failed signal shutdown without exposing its cause", async () => {
    const listeners = new Map<string, () => void>();
    const target = {
      exitCode: undefined as number | undefined,
      once(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.set(signal, listener);
      },
    };
    const report = vi.fn<(message: string) => void>();
    registerShutdownSignals(
      async () => {
        throw new Error("SECRET_SHUTDOWN_FAILURE");
      },
      target,
      report,
    );

    listeners.get("SIGTERM")?.();
    await vi.waitFor(() => expect(target.exitCode).toBe(1));
    expect(report).toHaveBeenCalledExactlyOnceWith("Graceful shutdown failed");
    expect(JSON.stringify(report.mock.calls)).not.toContain("SECRET");
  });
});
