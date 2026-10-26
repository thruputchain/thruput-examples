import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  addressFromBase58,
  createPubkeyAccount,
  createThruputClient,
  createWalletClient,
  Ed25519Signer,
  localnet,
  toBase58,
  TransactionExecutionError,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { gasAmount } from "@thruputchain/protocol";
import { Airdrop } from "../src/contracts/generated/airdrop";
import { loadConfig } from "../server/config";
import { waitForView } from "../../../examples/typescript/wait-for-view";

const env = {
  ...parseEnv(
    await readFile(process.env.AIRDROP_ENV_PATH || ".env.local", "utf8"),
  ),
  ...process.env,
};
const config = loadConfig(env);
const url = new URL(config.rpcUrl);
assert(
  url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "Use an isolated local deployment",
);
const client = await createThruputClient({
  cluster: localnet({ rpcUrl: config.rpcUrl }),
});
const account = createPubkeyAccount({
  signer: new Ed25519Signer(randomBytes(32)),
});
const wallet = createWalletClient({ client, account });
await wallet.requestAirdrop();
const address = addressFromBase58(config.publicConfig.address);
const options = { client, address, args: { address: account.address } };
assert(
  (await Airdrop.v0_1.eligible.view(options)).value,
  "Use an open airdrop for this test",
);
const request = {
  invocation: Airdrop.v0_1.claim.invocation(address, gasAmount(20000000n)),
  gasLimit: gasAmount(20000000n),
};
const result = await wallet.executeAndWait(request, { timeoutMs: 60000 });
assert(
  (
    await waitForView(() =>
      Airdrop.v0_1.hasClaimed.view({
        ...options,
        minStateBlockHeight: result.receipt.blockHeight,
      }),
    )
  ).value,
);
for (const token of config.publicConfig.tokens) {
  const balance = await waitForView(() =>
    ERC20.v0_1.getBalanceOf.view({
      client,
      address: addressFromBase58(token.address),
      args: { addr: account.address },
      minStateBlockHeight: result.receipt.blockHeight,
    }),
  );
  assert.equal(balance.value, BigInt(token.claimAmount));
}
await assert.rejects(
  () => wallet.executeAndWait(request, { timeoutMs: 60000 }),
  TransactionExecutionError,
);
console.log(
  `Confirmed every token balance and duplicate-claim rejection: ${toBase58(result.transactionHash)}`,
);
