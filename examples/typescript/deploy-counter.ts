import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createPubkeyAccount,
  createWalletClient,
  prepareContractDeployment,
  PrivateKeySigner,
  toBase58,
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
console.error(`Airdrop transaction: ${toBase58(funding.transactionHash)}`);

const deployment = prepareContractDeployment({
  deployer: account.address,
  contract,
});
const callGas = gasAmount(500_000n);
const walletGas = gasAmount(10_000_000n);
const { address, transactionHash: deployHash } =
  await wallet.deployContractAndWait(
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
console.error(`Deploy transaction: ${toBase58(deployHash)}`);

const { transactionHash: incrementHash, receipt } = await wallet.executeAndWait(
  {
    invocation: Counter.v0_1.increment.invocation(address, callGas, {
      amount: 5n,
    }),
    gasLimit: walletGas,
  },
  { timeoutMs: 60_000 },
);
console.error(`Increment transaction: ${toBase58(incrementHash)}`);
const view = await waitForView(() =>
  Counter.v0_1.get.view({
    client,
    address,
    caller: account.address,
    minStateBlockHeight: receipt.blockHeight,
  }),
);
assert.equal(view.value, 47n, "Counter should be 42 + 5");

// Leave one event for the separate read-events example to query.
const { transactionHash: eventHash } = await wallet.executeAndWait(
  {
    invocation: Counter.v0_1.ping.invocation(address, callGas, { tag: 7n }),
    gasLimit: walletGas,
  },
  { timeoutMs: 60_000 },
);
console.error(`Ping transaction: ${toBase58(eventHash)}`);

console.log(
  JSON.stringify(
    {
      account: toBase58(account.address),
      contractAddress: toBase58(address),
      deployHash: toBase58(deployHash),
      incrementHash: toBase58(incrementHash),
      eventHash: toBase58(eventHash),
      value: view.value.toString(),
    },
    null,
    2,
  ),
);
