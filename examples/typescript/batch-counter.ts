import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  addressFromHex,
  createPubkeyAccount,
  createWalletClient,
  fixedBytes,
  PrivateKeySigner,
  toHex0x,
} from "@thruputchain/client";
import { DefaultWallet } from "@thruputchain/client/contracts";
import { ExecResult, gasAmount, type Invocation } from "@thruputchain/protocol";
import { Counter } from "./generated/counter.ts";
import { createLocalClient } from "./local-client.ts";
import { waitForView } from "./wait-for-view.ts";

const addressHex = process.env.THRUPUT_COUNTER_ADDRESS;
if (!addressHex)
  throw new Error(
    "Set THRUPUT_COUNTER_ADDRESS to the deployed Counter address",
  );
const address = addressFromHex(addressHex);
const client = await createLocalClient();
const account = createPubkeyAccount({
  signer: new PrivateKeySigner(randomBytes(32)),
});
const wallet = createWalletClient({ client, account });
const funding = await wallet.requestAirdrop();
assert.equal(funding.status.result, "ok", "Airdrop failed");
const gas = gasAmount(500_000n);

// The native DefaultWallet executes the ordered calls in one transaction.
async function batch(calls: Invocation[]) {
  const hash = await wallet.sendInvocation({
    invocation: DefaultWallet.v0_1.execute.invocation(
      account.address,
      gasAmount(10_000_000n),
      {
        calls: calls.map((call) => ({
          target: call.invoked_address,
          entrypoint: fixedBytes(call.entrypoint, 8),
          gas_limit: call.gas_limit,
          calldata: call.calldata,
        })),
      },
    ),
  });
  // Print the hash before waiting so a timeout can be investigated without resending.
  console.error(`Submitted batch: ${toHex0x(hash)}`);
  return wallet.waitForTransactionReceipt(hash, { timeoutMs: 60_000 });
}
const before = await Counter.v0_1.get.view({
  client,
  contract: address,
  caller: account.address,
});
const success = await batch([
  Counter.v0_1.increment.invocation(address, gas, { amount: 5n }),
  Counter.v0_1.decrement.invocation(address, gas, { amount: 2n }),
]);
assert.equal(success.execResult, ExecResult.ExecResultOK);
const after = await waitForView(() =>
  Counter.v0_1.get.view({
    client,
    contract: address,
    caller: account.address,
    minHeight: success.height,
  }),
);
assert.equal(after.value, before.value + 3n);

const reverted = await batch([
  Counter.v0_1.increment.invocation(address, gas, { amount: 5n }),
  Counter.v0_1.error.invocation(address, gas),
]);
assert.equal(reverted.execResult, ExecResult.ExecResultTxRootFrameReverted);
const final = await waitForView(() =>
  Counter.v0_1.get.view({
    client,
    contract: address,
    caller: account.address,
    minHeight: reverted.height,
  }),
);
assert.equal(
  final.value,
  after.value,
  "The failed batch must roll back its increment",
);

console.log(
  JSON.stringify(
    {
      before: before.value.toString(),
      after: after.value.toString(),
      afterRollback: final.value.toString(),
      successHash: toHex0x(success.txHash),
      revertedHash: toHex0x(reverted.txHash),
    },
    null,
    2,
  ),
);
