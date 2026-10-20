// @vitest-environment node

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { hashContract, toBase58 } from "@thruputchain/client";
import { ContractType } from "@thruputchain/protocol";
import { createThruputRegistrySource } from "./chain.ts";

import { ServerConfigurationError } from "./config.ts";
import {
  createGracefulShutdown,
  registerShutdownSignals,
  reportStartupFailure,
  startupFailureMessage,
  start,
} from "./main.ts";

const b58 = (byte: number) => toBase58(new Uint8Array(32).fill(byte));

vi.mock("./chain.ts", () => ({ createThruputRegistrySource: vi.fn() }));

const environment = {
  VITE_THRUPUT_RPC_URL: "https://rpc.example.test/thruput",
  VITE_THRUPUT_NETWORK_ID: b58(0x11),
  VITE_POOL_TOKEN_HASH: b58(0x22),
  VITE_NATIVE_HOG_ADDRESS: b58(0x44),
  VITE_SWAP_FACTORY_ADDRESS: b58(0x66),
  VITE_SWAP_ROUTER_ADDRESS: b58(0x77),
};

describe("production startup reporting", () => {
  let directory: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.mocked(createThruputRegistrySource).mockReset();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it.each(["missing", "tampered", "extra fields", "valid"])(
    "validates the served artifact before RPC or database startup: %s",
    async (state) => {
      directory = await mkdtemp(
        path.join(os.tmpdir(), "swap-startup-artifact-"),
      );
      const hash = toBase58(
        hashContract({
          contract_type: ContractType.kRv32,
          rv32_contract: { data: new Uint8Array([1, 2, 3]) },
        }),
      );
      const settings = {
        ...environment,
        VITE_POOL_TOKEN_HASH: hash,
        PORT: "3000",
        POOL_REGISTRY_DB_PATH: path.join(
          directory,
          "not-created",
          "pools.sqlite",
        ),
        VITE_TOKEN_DISCOVERY_ENABLED: "false",
        VITE_STANDARD_TOKEN_FACTORY_ADDRESS: "",
        VITE_STANDARD_TOKEN_HASH: "",
        TOKEN_DISCOVERY_UPSTREAM_ORIGIN: "",
        VITE_EXPLORER_URL: "",
      };
      for (const [key, value] of Object.entries(settings))
        vi.stubEnv(key, value);
      await writeFile(
        path.join(directory, "index.html"),
        "<main>fixture</main>",
      );
      if (state !== "missing") {
        await mkdir(path.join(directory, "contract-artifacts"));
        await writeFile(
          path.join(directory, "contract-artifacts", `${hash}.json`),
          JSON.stringify({
            contractType: "rv32",
            data: state === "tampered" ? "0x04" : "0x010203",
            hash,
            ...(state === "extra fields" ? { extra: true } : {}),
          }),
        );
      }
      const stopBeforeNetwork = new Error(
        "Validated assets; stop before network access",
      );
      vi.mocked(createThruputRegistrySource).mockRejectedValue(
        stopBeforeNetwork,
      );
      if (state === "valid") {
        await expect(start(directory)).rejects.toBe(stopBeforeNetwork);
        expect(createThruputRegistrySource).toHaveBeenCalledOnce();
      } else {
        await expect(start(directory)).rejects.toThrow(/artifact/);
        expect(createThruputRegistrySource).not.toHaveBeenCalled();
      }
      await expect(access(settings.POOL_REGISTRY_DB_PATH)).rejects.toThrow();
    },
  );

  it("reports only safe configuration error classes with exact messages", () => {
    expect(
      startupFailureMessage(
        new ServerConfigurationError("PORT must be between 1 and 65535"),
      ),
    ).toBe("Pool registry failed to start: PORT must be between 1 and 65535");
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
