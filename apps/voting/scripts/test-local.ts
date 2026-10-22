import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createPubkeyAccount,
  createWalletClient,
  Ed25519Signer,
  TransactionExecutionError,
  toBase58,
} from "@thruputchain/client";
import type { Invocation } from "@thruputchain/protocol";
import { deployVoting, localClient } from "./setup-local";
import {
  GAS,
  methods,
  readPoll,
  listPolls,
  type Definition,
} from "../src/contracts/polls";

const client = await localClient();
const address = await deployVoting(client);
const config = { address, networkId: toBase58(client.network.networkHash) };
async function participant() {
  const account = createPubkeyAccount({
    signer: new Ed25519Signer(randomBytes(32)),
  });
  const wallet = createWalletClient({ client, account });
  assert.equal((await wallet.requestAirdrop()).attemptStatus, "succeeded");
  return wallet;
}
const admin = await participant();
const voter = await participant();
let height = 0n;
async function send(wallet: typeof admin, invocation: Invocation) {
  const result = await wallet.executeAndWait(
    { invocation, gasLimit: GAS },
    { timeoutMs: 60_000 },
  );
  height = result.receipt.blockHeight;
  console.log(`Confirmed: ${toBase58(result.transactionHash)}`);
  return result;
}
async function rejects(wallet: typeof admin, invocation: Invocation) {
  await assert.rejects(
    () => send(wallet, invocation),
    TransactionExecutionError,
  );
}
const definition: Definition = {
  title: "Community priorities",
  description: "Localnode integration test",
  questions: [
    { title: "What should we build?", options: ["Wallet", "Explorer"] },
    { title: "When should we meet?", options: ["Monday", "Friday"] },
  ],
};
await send(admin, methods.createPoll.invocation(address, GAS, { definition }));
await send(
  admin,
  methods.editPoll.invocation(address, GAS, {
    id: 0n,
    definition: { ...definition, title: "Community priorities — reviewed" },
  }),
);
await rejects(voter, methods.openPoll.invocation(address, GAS, { id: 0n }));
await rejects(
  voter,
  methods.vote.invocation(address, GAS, { id: 0n, question: 0n, option: 0n }),
);
await send(admin, methods.openPoll.invocation(address, GAS, { id: 0n }));
await send(
  admin,
  methods.vote.invocation(address, GAS, { id: 0n, question: 0n, option: 0n }),
);
await send(
  voter,
  methods.vote.invocation(address, GAS, { id: 0n, question: 0n, option: 1n }),
);
await rejects(
  voter,
  methods.vote.invocation(address, GAS, { id: 0n, question: 0n, option: 0n }),
);
await send(
  voter,
  methods.vote.invocation(address, GAS, { id: 0n, question: 1n, option: 0n }),
);
await send(admin, methods.closePoll.invocation(address, GAS, { id: 0n }));
await rejects(admin, methods.openPoll.invocation(address, GAS, { id: 0n }));
await rejects(
  admin,
  methods.vote.invocation(address, GAS, { id: 0n, question: 1n, option: 0n }),
);
const poll = await methods.getPoll.view({
  client,
  address,
  args: { id: 0n },
  minStateBlockHeight: height,
});
assert.equal(poll.value.status, 2n);
const state = await readPoll(
  client,
  config,
  0n,
  toBase58(voter.account.address),
);
assert.equal(state.participants, 2n);
assert.deepEqual(state.totals, [
  [1n, 1n],
  [1n, 0n],
]);
assert.deepEqual(state.answers, [1n, 0n]);
assert.equal((await listPolls(client, config, 0)).polls.length, 1);

// Exercise maximum ABI sizes in the real RV32 guest, not only native Rust.
const maximum: Definition = {
  title: "T".repeat(160),
  description: "D".repeat(512),
  questions: Array.from({ length: 8 }, () => ({
    title: "Q".repeat(160),
    options: Array.from({ length: 6 }, (_, i) => `${i}${"O".repeat(95)}`),
  })),
};
await send(
  admin,
  methods.createPoll.invocation(address, GAS, { definition: maximum }),
);
await send(admin, methods.openPoll.invocation(address, GAS, { id: 1n }));
await send(
  voter,
  methods.vote.invocation(address, GAS, { id: 1n, question: 7n, option: 5n }),
);
const maxState = await readPoll(
  client,
  config,
  1n,
  toBase58(voter.account.address),
);
assert.equal(maxState.totals[7]?.[5], 1n);
console.log(`Voting localnode checks passed. Contract: ${toBase58(address)}`);
