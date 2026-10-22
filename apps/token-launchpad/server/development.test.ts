// @vitest-environment node

import { toBase58 } from "@thruputchain/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { expect, it, vi } from "vitest";
import { developmentRegistry } from "./development";
import { RegistryStore } from "./store";

vi.mock("./chain", () => ({
  createThruputRegistrySource: async () => ({
    verifyNetworkIdentity: async () => {},
    getPage: async () => ({
      tokens: [],
      nextCursor: null,
      latestBlock: "1",
      oldestBlock: "1",
    }),
  }),
}));

it("serves the real token registry API from the development server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-dev-registry-"));
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      developmentRegistry({
        VITE_NATIVE_TOKEN_ADDRESS: toBase58(new Uint8Array(32).fill(0x03)),
        VITE_NATIVE_BALANCE_ITEM_COST: "1234",
        VITE_THRUPUT_RPC_URL: "http://127.0.0.1:1",
        VITE_THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(0x00)),
        VITE_STANDARD_TOKEN_FACTORY_ADDRESS: toBase58(
          new Uint8Array(32).fill(0x01),
        ),
        VITE_STANDARD_TOKEN_HASH: toBase58(new Uint8Array(32).fill(0x02)),
        TOKEN_REGISTRY_DB_PATH: path.join(root, "registry.sqlite"),
      }),
    ],
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP port");
    const origin = `http://127.0.0.1:${address.port}`;
    const tokens = await fetch(`${origin}/api/tokens`);
    const runtime = await (await fetch(`${origin}/api/config`)).json();
    expect(runtime.VITE_STANDARD_TOKEN_HASH).toBe(
      toBase58(new Uint8Array(32).fill(0x02)),
    );
    expect(runtime.VITE_THRUPUT_RPC_URL).toBeUndefined();
    expect(tokens.status).toBe(200);
    expect(await tokens.json()).toMatchObject({ tokens: [], total: 0 });
    const sync = await fetch(`${origin}/api/registry/sync`, { method: "POST" });
    expect(sync.status).toBe(202);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("closes its store when Vite shuts down in middleware mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-dev-close-"));
  const close = vi.spyOn(RegistryStore.prototype, "close");
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [
      developmentRegistry({
        VITE_NATIVE_TOKEN_ADDRESS: toBase58(new Uint8Array(32).fill(0x03)),
        VITE_NATIVE_BALANCE_ITEM_COST: "1234",
        VITE_THRUPUT_RPC_URL: "http://127.0.0.1:1",
        VITE_THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(0x00)),
        VITE_STANDARD_TOKEN_FACTORY_ADDRESS: toBase58(
          new Uint8Array(32).fill(0x01),
        ),
        VITE_STANDARD_TOKEN_HASH: toBase58(new Uint8Array(32).fill(0x02)),
      }),
    ],
  });
  try {
    await server.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await server.close();
    close.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
