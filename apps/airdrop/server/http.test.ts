import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createApiHandler } from "./http";
import { loadConfig } from "./config";
import { toBase58 } from "@thruputchain/client";
import { parseTokens } from "../shared/config";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server?.closeAllConnections();
});
const address = (n: number) => toBase58(new Uint8Array(32).fill(n));
const tokens = [
  {
    address: address(3),
    symbol: "TEST",
    name: "Test token",
    decimals: 6,
    claimAmount: "1000",
  },
];
it("accepts a configurable token list and rejects duplicates or empty rewards", () => {
  expect(parseTokens(tokens)).toEqual(tokens);
  expect(() => parseTokens([])).toThrow();
  expect(() => parseTokens([...tokens, ...tokens])).toThrow();
  expect(() => parseTokens([{ ...tokens[0], claimAmount: "0" }])).toThrow();
});
it("serves public config without a signer and refuses RPC writes", async () => {
  const config = loadConfig({
    THRUPUT_RPC_URL: "http://127.0.0.1:9545",
    THRUPUT_NETWORK_ID: address(1),
    AIRDROP_ADDRESS: address(2),
    AIRDROP_ANCHOR_HASH: address(4),
    AIRDROP_TOKENS: JSON.stringify(tokens),
  });
  const handler = createApiHandler(config);
  server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const socket = server.address();
  if (!socket || typeof socket === "string") throw new Error("Missing address");
  const base = `http://127.0.0.1:${socket.port}`;
  expect(await (await fetch(`${base}/api/config`)).json()).toEqual(
    config.publicConfig,
  );
  const response = await fetch(`${base}/thruput-rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: {},
    }),
  });
  expect(response.status).toBe(403);
});
