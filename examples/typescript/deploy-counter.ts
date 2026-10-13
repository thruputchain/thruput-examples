import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createPubkeyAccount,
  createWalletClient,
  prepareContractDeployment,
  PrivateKeySigner,
  toHex0x,
} from "@thruputchain/client";
import { gasAmount } from "@thruputchain/protocol";
import { Counter } from "./generated/counter.ts";
import { createLocalClient } from "./local-client.ts";
import { waitForView } from "./wait-for-view.ts";

// Build this artifact and its binding together with npm run examples:generate.
const contract = await readFile(
  new URL("../../target/thruput/counter.rv32a", import.meta.url),
);
const client = await createLocalClient();
const account = createPubkeyAccount({
  signer: new PrivateKeySigner(randomBytes(32)),
});
const wallet = createWalletClient({ client, account });
const funding = await wallet.requestAirdrop();
assert.equal(funding.status.result, "ok", "Airdrop failed");

const deployment = prepareContractDeployment({
  deployer: account.address,
  contract,
});
const callGas = gasAmount(500_000n);
const walletGas = gasAmount(10_000_000n);
const { address, txHash: deployHash } = await wallet.deployContractAndWait(
  deployment,
  {
    gasLimit: walletGas,
    amount: 10_000_000n, // 1 test HOG for this contract's local storage reserve.
    initializer: Counter.v0_1.initialize.invocation(
      deployment.address,
      callGas,
      { initialValue: 42n },
    ),
  },
  { timeoutMs: 60_000 },
);

const { txHash: incrementHash, receipt } = await wallet.executeAndWait(
  {
    invocation: Counter.v0_1.increment.invocation(address, callGas, {
      amount: 5n,
    }),
    gasLimit: walletGas,
  },
  { timeoutMs: 60_000 },
);
const view = await waitForView(() =>
  Counter.v0_1.get.view({
    client,
    contract: address,
    caller: account.address,
    minHeight: receipt.height,
  }),
);
assert.equal(view.value, 47n, "Counter should be 42 + 5");

// Leave one event for the separate read-events example to query.
const { txHash: eventHash } = await wallet.executeAndWait(
  {
    invocation: Counter.v0_1.ping.invocation(address, callGas, { tag: 7n }),
    gasLimit: walletGas,
  },
  { timeoutMs: 60_000 },
);

console.log(
  JSON.stringify(
    {
      account: toHex0x(account.address),
      contractAddress: toHex0x(address),
      deployHash: toHex0x(deployHash),
      incrementHash: toHex0x(incrementHash),
      eventHash: toHex0x(eventHash),
      value: view.value.toString(),
    },
    null,
    2,
  ),
);
