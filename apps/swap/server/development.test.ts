// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { toBase58 } from "@thruputchain/client";
import { expect, it, vi } from "vitest";
import { developmentRegistry } from "./development";
import { RegistryStore } from "./store";

const b58 = (byte: number) => toBase58(new Uint8Array(32).fill(byte));

vi.mock("./chain", () => ({
  createThruputRegistrySource: async () => ({
    verifyNetworkIdentity: async () => {},
    getPage: async () => ({
      pools: [],
      nextCursor: null,
      latestBlock: "1",
      oldestBlock: "1",
    }),
  }),
}));

it("serves the real pool registry API from the development server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swap-dev-registry-"));
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      developmentRegistry({
        VITE_NATIVE_TOKEN_ADDRESS: b58(0x03),
        VITE_SWAP_ROUTER_ADDRESS: b58(0x04),
        VITE_THRUPUT_RPC_URL: "http://127.0.0.1:1",
        VITE_THRUPUT_NETWORK_ID: b58(0x00),
        VITE_SWAP_FACTORY_ADDRESS: b58(0x01),
        POOL_REGISTRY_DB_PATH: path.join(root, "registry.sqlite"),
      }),
    ],
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP port");
    const origin = `http://127.0.0.1:${address.port}`;
    const pools = await fetch(`${origin}/api/pools`);
    const runtime = await (await fetch(`${origin}/api/config`)).json();
    expect(runtime.VITE_SWAP_ROUTER_ADDRESS).toBe(b58(0x04));
    expect(runtime.VITE_THRUPUT_RPC_URL).toBeUndefined();
    expect(pools.status).toBe(200);
    expect(await pools.json()).toMatchObject({ pools: [], total: 0 });
    const sync = await fetch(`${origin}/api/registry/sync`, { method: "POST" });
    expect(sync.status).toBe(202);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("closes its store when Vite shuts down in middleware mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swap-dev-close-"));
  const close = vi.spyOn(RegistryStore.prototype, "close");
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [
      developmentRegistry({
        VITE_NATIVE_TOKEN_ADDRESS: b58(0x03),
        VITE_SWAP_ROUTER_ADDRESS: b58(0x04),
        VITE_THRUPUT_RPC_URL: "http://127.0.0.1:1",
        VITE_THRUPUT_NETWORK_ID: b58(0x00),
        VITE_SWAP_FACTORY_ADDRESS: b58(0x01),
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
