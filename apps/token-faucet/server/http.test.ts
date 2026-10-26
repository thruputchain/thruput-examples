import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createPubkeyAccount,
  Ed25519Signer,
  toBase58,
} from "@thruputchain/client";
import { loadConfig } from "./config";
import { ClaimStore } from "./store";
import { Claims } from "./claims";
import { createApiHandler } from "./http";

const secret = "01".repeat(32);
const account = createPubkeyAccount({
  signer: new Ed25519Signer(new Uint8Array(32).fill(2)),
});
const address = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
let server: Server | undefined;
let claims: Claims | undefined;
afterEach(async () => {
  server?.close();
  server?.closeAllConnections();
  await claims?.stop();
  claims?.store.close();
});
async function start() {
  const config = loadConfig({
    THRUPUT_RPC_URL: "https://rpc.example.test",
    THRUPUT_NETWORK_ID: address(1),
    FAUCET_ANCHOR_HEIGHT: "1",
    FAUCET_ANCHOR_HASH: address(2),
    FAUCET_ADDRESS: toBase58(account.address),
    FAUCET_SIGNING_PRIVATE_KEY: `0x${"02".repeat(32)}`,
    FAUCET_PROXY_SECRET: secret,
    FAUCET_IP_SALT: secret,
    FAUCET_DB_PATH: ":memory:",
    SWAP_APP_URL: "https://example.test/swap/",
    FAUCET_IP_CLAIMS_PER_HOUR: "1",
    FAUCET_TOKENS: JSON.stringify(
      ["tUSDC", "tEURC", "tBTC", "tETH", "tSOL", "tDOGE"].map((symbol, i) => ({
        address: address(i + 10),
        symbol,
        name: symbol,
        decimals: 6,
        claimAmount: "1000",
      })),
    ),
  });
  const store = new ClaimStore(":memory:", config.publicConfig, config.policy);
  claims = new Claims(config.publicConfig, store, {
    check: async () => {},
    inventory: async () => ({ balances: [], packs: 100 }),
    prepare: async () => ({
      hash: address(8),
      signed: "0x1234",
      broadcast: async () => {},
    }),
    observe: async () => "pending",
  });
  await claims.start();
  await claims.tick();
  const api = createApiHandler(config, claims);
  server = createServer((req, res) => {
    void api(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const socket = server.address();
  if (!socket || typeof socket === "string")
    throw new Error("Missing test address");
  const base = `http://127.0.0.1:${socket.port}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Faucet-Proxy-Key": secret,
    "X-Faucet-Client-IP": "192.0.2.1",
  };
  const body = {
    id: randomUUID(),
    recipient: address(30),
    networkId: config.publicConfig.networkId,
    anchorHash: config.publicConfig.anchorHash,
  };
  return { base, headers, body };
}
it("rejects direct proxy bypass and isolates public configuration", async () => {
  const { base, headers } = await start();
  expect((await fetch(`${base}/api/config`)).status).toBe(403);
  const response = await fetch(`${base}/api/config`, { headers });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(secret);
  expect(text).not.toContain("signing");
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
});
it("checks chain identity and persists IP quotas across different recipient addresses", async () => {
  const { base, headers, body } = await start();
  const post = (value: unknown, extra = {}) =>
    fetch(`${base}/api/claims`, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(value),
    });
  expect((await post({ ...body, anchorHash: address(99) })).status).toBe(400);
  expect((await post(body, { "Sec-Fetch-Site": "cross-site" })).status).toBe(
    403,
  );
  expect((await post(body)).status).toBe(202);
  const duplicate = await post(body);
  expect(duplicate.status).toBe(202);
  expect((await duplicate.json()).id).toBe(body.id);
  const limited = await post(
    { ...body, id: randomUUID(), recipient: address(31) },
    { "X-Forwarded-For": "198.51.100.1" },
  );
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("3600");
  const record = await (
    await fetch(`${base}/api/claims/${body.id}`, { headers })
  ).json();
  expect(record).not.toHaveProperty("signed");
  expect(record).not.toHaveProperty("ip");
});
