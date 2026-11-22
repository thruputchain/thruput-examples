import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { createApiHandler, json } from "./http";

const env = {
  THRUPUT_RPC_URL: "http://127.0.0.1:1",
  VITE_THRUPUT_NETWORK_ID: "11111111111111111111111111111111",
  VITE_NFT_DROP_FACTORY: "11111111111111111111111111111111",
  NFT_CROWD_SEED: `0x${"07".repeat(32)}`,
  NFT_CROWD_SIZE: "100",
};

let server: Server | undefined;
afterEach(() => server?.close());

async function start(values: Record<string, string> = env) {
  const api = createApiHandler(loadConfig(values));
  server = createServer((request, response) => {
    void api(request, response).then((handled) => {
      if (!handled) json(response, 404, { error: "Not found." });
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("API", () => {
  it("serves public configuration without the crowd seed", async () => {
    const base = await start();
    const config = await (await fetch(`${base}/api/config`)).json();
    expect(config).toEqual({
      VITE_THRUPUT_NETWORK_ID: env.VITE_THRUPUT_NETWORK_ID,
      VITE_NFT_DROP_FACTORY: env.VITE_NFT_DROP_FACTORY,
      NFT_CROWD_SIZE: "100",
    });
    expect(JSON.stringify(config)).not.toContain("07070707");
  });

  it("proxies only read-only RPC methods", async () => {
    const base = await start();
    const response = await post(`${base}/thruput-rpc`, {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: {},
    });
    expect(response.status).toBe(403);
  });

  it("has no rush before the first one starts", async () => {
    const base = await start();
    expect(await (await fetch(`${base}/api/rush`)).json()).toEqual({
      rush: null,
    });
  });

  it("refuses rush input outside the limits", async () => {
    const base = await start();
    for (const body of [
      { drop: env.VITE_NFT_DROP_FACTORY, users: 0, windowSeconds: 5 },
      { drop: env.VITE_NFT_DROP_FACTORY, users: 101, windowSeconds: 5 },
      { drop: env.VITE_NFT_DROP_FACTORY, users: 10, windowSeconds: 61 },
      { drop: "not base58!", users: 10, windowSeconds: 5 },
    ]) {
      const response = await post(`${base}/api/rush`, body);
      expect(response.status).toBe(400);
    }
  });

  it("refuses a rush when no crowd is configured", async () => {
    const base = await start({ ...env, NFT_CROWD_SEED: "" });
    const response = await post(`${base}/api/rush`, {
      drop: env.VITE_NFT_DROP_FACTORY,
      users: 1,
      windowSeconds: 0,
    });
    expect(response.status).toBe(503);
  });
});
