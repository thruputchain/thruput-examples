import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  addressFromHex,
  createPubkeyAccount,
  PrivateKeySigner,
  toHex0x,
} from "@groundhogchain/client";
import { ERC20 } from "@groundhogchain/client/contracts";
import { durableMkdir } from "../../../scripts/seed/seed-journal.ts";
import { readManifest } from "../server/config.ts";
import { connectChain } from "../server/chain.ts";
import { ClaimService } from "../server/claims.ts";
import { faucetServer } from "../server/http.ts";
import type { ClaimStatus } from "../src/domain.ts";

// Explicit live test: transfers ten of each token to a new devnet account.
const manifest = await readManifest(
  resolve(process.env.FAUCET_MANIFEST ?? "deployments/devnet.json"),
);
const chain = await connectChain(
  manifest,
  resolve(process.env.FAUCET_KEY_FILE ?? ".local/devnet/signer.key"),
);
const directory = resolve(".local/verification-claims");
await durableMkdir(directory);
const lock = resolve(directory, "lock");
await mkdir(lock);
const service = new ClaimService(directory, manifest.tokens, chain);
const server = faucetServer(manifest, service, resolve("dist"));
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
try {
  const user = createPubkeyAccount({
    signer: new PrivateKeySigner(randomBytes(32)),
  });
  const claim = async (token: string) => {
    const response = await fetch(`${origin}/api/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, address: toHex0x(user.address) }),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as ClaimStatus;
  };
  for (const token of manifest.tokens) {
    const first = await claim(token.address);
    const second = await claim(token.address);
    assert.equal(first.state, "claimed");
    assert.equal(second.transactionHash, first.transactionHash);
    assert.equal(
      (
        await ERC20.getBalanceOf.view({
          client: chain.client,
          contract: addressFromHex(token.address),
          args: { addr: user.address },
        })
      ).value,
      10n * 10n ** BigInt(token.decimals),
    );
    console.log(`Verified one-time claim: 10 ${token.symbol}`);
  }
  const invalid = await fetch(`${origin}/api/claims`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(invalid.status, 400);
  const traversal = await fetch(`${origin}/.local/devnet/signer.key`);
  assert.equal(traversal.status, 404);
  console.log("Live faucet claims and duplicate-claim protection passed.");
} finally {
  await new Promise<void>((done) => server.close(() => done()));
  await service.drain();
  await rmdir(lock);
}
