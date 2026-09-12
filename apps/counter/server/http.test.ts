import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadServerConfig } from "./config";
import { handleApi } from "./http";
import { createCounterServer } from "./main";

const config = loadServerConfig({
  VITE_GROUNDHOG_NETWORK_ID: "00".repeat(32),
  VITE_COUNTER_ADDRESS: "11".repeat(32),
  COUNTER_DEVELOPMENT_PRIVATE_KEY: "22".repeat(32),
  VITE_GROUNDHOG_RPC_URL: "http://127.0.0.1:9545",
});
let server: Server;
async function listen(instance: Server) {
  server = instance;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
});

describe("counter HTTP boundary", () => {
  it("serves only the explicit public demo config, with no cache", async () => {
    const origin = await listen(createCounterServer(config));
    const response = await fetch(`${origin}/api/config`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(config.app);
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
  });

  it("forwards one signed transaction once and permits receipt reads", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ jsonrpc: "2.0", id: 1, result: "0x1234" }),
      );
    const origin = await listen(
      createServer((req, res) => {
        void handleApi(req, res, config, upstream);
      }),
    );
    for (const method of [
      "groundhog_sendRawTransaction",
      "groundhog_getTransactionReceipt",
    ]) {
      const body = { jsonrpc: "2.0", id: 1, method, params: ["0x1234"] };
      expect(
        (
          await fetch(`${origin}/groundhog-rpc`, {
            method: "POST",
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(200);
      expect(upstream).toHaveBeenLastCalledWith(
        config.rpcUrl,
        expect.objectContaining({
          body: JSON.stringify(body),
          redirect: "error",
        }),
      );
    }
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not replay a submission after an upstream error", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("lost response"));
    const origin = await listen(
      createServer((req, res) => {
        void handleApi(req, res, config, upstream);
      }),
    );
    const response = await fetch(`${origin}/groundhog-rpc`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_sendRawTransaction",
        params: ["0x1234"],
      }),
    });
    expect(response.status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects batches, malformed input, and non-app RPC methods", async () => {
    const upstream = vi.fn<typeof fetch>();
    const origin = await listen(
      createServer((req, res) => {
        void handleApi(req, res, config, upstream);
      }),
    );
    for (const body of [
      "[]",
      "null",
      "{",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "groundhog_requestAirdrop",
      }),
    ]) {
      expect(
        (await fetch(`${origin}/groundhog-rpc`, { method: "POST", body }))
          .status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps environment files and traversal paths out of the static server", async () => {
    const origin = await listen(createCounterServer(config));
    for (const path of [
      "/.env.local",
      "/%2e%2e/server/config.ts",
      "/server/main.ts",
      "/assets/../../package.json",
    ]) {
      expect((await fetch(`${origin}${path}`)).status).toBe(404);
    }
  });
});
