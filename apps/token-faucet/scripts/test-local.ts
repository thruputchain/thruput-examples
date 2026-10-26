import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  addressFromBase58,
  createPubkeyAccount,
  createThruputClient,
  Ed25519Signer,
  localnet,
  toBase58,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { startFaucet } from "../server/runtime";
import { createApiHandler } from "../server/http";
import type { Claim } from "../shared/config";

const env = {
  ...parseEnv(
    await readFile(process.env.FAUCET_ENV_PATH || ".env.local", "utf8"),
  ),
  ...process.env,
};
const url = new URL(env.THRUPUT_RPC_URL!);
assert(
  url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
  "Use an isolated local node",
);
const directory = await mkdtemp(join(tmpdir(), "faucet-live-"));
env.FAUCET_DB_PATH = join(directory, "claims.sqlite");
env.FAUCET_PROXY_SECRET = "";
const runtime = await startFaucet(env);
let closed = false;
const api = createApiHandler(runtime.config, runtime.claims);
const server = createServer((req, res) => {
  void api(req, res);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const socket = server.address();
assert(socket && typeof socket === "object");
const base = `http://127.0.0.1:${socket.port}`;
const recipient = createPubkeyAccount({
  signer: new Ed25519Signer(randomBytes(32)),
});
const request = {
  id: randomUUID(),
  recipient: toBase58(recipient.address),
  networkId: runtime.config.publicConfig.networkId,
  anchorHash: runtime.config.publicConfig.anchorHash,
};
const post = (body: typeof request) =>
  fetch(`${base}/api/claims`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
try {
  assert.equal((await post({ ...request, anchorHash: "wrong" })).status, 400);
  const response = await post(request);
  assert.equal(response.status, 202);
  let claim = (await response.json()) as Claim;
  const deadline = Date.now() + 60_000;
  while (
    claim.status !== "confirmed" &&
    claim.status !== "failed" &&
    Date.now() < deadline
  ) {
    await delay(1000);
    claim = (await (
      await fetch(`${base}/api/claims/${request.id}`)
    ).json()) as Claim;
  }
  assert.equal(
    claim.status,
    "confirmed",
    `Inspect claim ${request.id} in ${directory}`,
  );
  const duplicate = (await (await post(request)).json()) as Claim;
  assert.equal(duplicate.hash, claim.hash);
  assert.equal((await post({ ...request, id: randomUUID() })).status, 429);
  const client = await createThruputClient({
    cluster: localnet({ rpcUrl: url.href }),
  });
  for (const token of runtime.config.publicConfig.tokens) {
    const balance = await ERC20.v0_1.getBalanceOf.view({
      client,
      address: addressFromBase58(token.address),
      args: { addr: recipient.address },
    });
    assert.equal(balance.value, BigInt(token.claimAmount), token.symbol);
  }
  await runtime.close();
  closed = true;
  const restarted = await startFaucet(env);
  try {
    assert.equal(restarted.claims.store.get(request.id)?.hash, claim.hash);
  } finally {
    await restarted.close();
  }
  console.log(
    `Confirmed all six balances, idempotency, cooldown, and restart recovery. Transaction: ${claim.hash}`,
  );
} finally {
  server.close();
  server.closeAllConnections();
  if (!closed) await runtime.close();
  // Keep the private evidence database for inspection after this live test.
  console.log(`Claim evidence: ${directory}`);
}
