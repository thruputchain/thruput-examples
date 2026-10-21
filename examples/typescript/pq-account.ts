import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createPubkeyAccount,
  createWalletClient,
  MlDsa65Signer,
  parseUnits,
  PrivateKeySigner,
  toBase58,
  type PubkeyAccount,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { gasAmount, HOG_ADDRESS } from "@thruputchain/protocol";
import { createLocalClient } from "./local-client.ts";
import { waitForView } from "./wait-for-view.ts";

const client = await createLocalClient();

// The only scheme-specific line: pick a signer. Disposable keys, never saved.
const ed25519Sender = createPubkeyAccount({
  signer: new PrivateKeySigner(randomBytes(32)),
});
const mlDsa65Sender = createPubkeyAccount({
  signer: MlDsa65Signer.fromSeed(randomBytes(32)),
});
const recipient = createPubkeyAccount({
  signer: new PrivateKeySigner(randomBytes(32)),
});

// Fund the recipient once so the tiny transfers need not pay for a balance row.
const recipientFunding = await client.requestAirdrop({
  recipient: recipient.address,
});
assert.equal(recipientFunding.status.result, "ok", "Recipient airdrop failed");
const before = await waitForView(() =>
  ERC20.v0_1.getBalanceOf.view({
    client,
    contract: HOG_ADDRESS,
    caller: recipient.address,
    args: { addr: recipient.address },
    minHeight: recipientFunding.height,
  }),
);

const amount = parseUnits("0.0001", 7); // HOG has seven decimal places.

// Everything from here on is identical for both accounts.
async function fundAndTransfer(sender: PubkeyAccount) {
  const wallet = createWalletClient({ client, account: sender });
  const funding = await wallet.requestAirdrop();
  assert.equal(funding.status.result, "ok", "Sender airdrop failed");
  const { txHash, receipt } = await wallet.executeAndWait(
    {
      invocation: ERC20.v0_1.transfer.invocation(
        HOG_ADDRESS,
        gasAmount(500_000n),
        { receiver: recipient.address, amount },
      ),
      gasLimit: gasAmount(1_000_000n),
    },
    { timeoutMs: 60_000 },
  );
  console.error(`committed ${toBase58(txHash)}`);
  return {
    sender: toBase58(sender.address),
    txHash: toBase58(txHash),
    receipt,
  };
}

const ed25519 = await fundAndTransfer(ed25519Sender);
const mlDsa65 = await fundAndTransfer(mlDsa65Sender);

const lastHeight =
  ed25519.receipt.height > mlDsa65.receipt.height
    ? ed25519.receipt.height
    : mlDsa65.receipt.height;
const after = await waitForView(() =>
  ERC20.v0_1.getBalanceOf.view({
    client,
    contract: HOG_ADDRESS,
    caller: recipient.address,
    args: { addr: recipient.address },
    minHeight: lastHeight,
  }),
);
assert.equal(
  after.value,
  before.value + 2n * amount,
  "Recipient did not receive both transfers",
);

console.log(
  JSON.stringify(
    {
      recipient: toBase58(recipient.address),
      transferredRawEach: amount.toString(),
      ed25519: { sender: ed25519.sender, txHash: ed25519.txHash },
      mlDsa65: { sender: mlDsa65.sender, txHash: mlDsa65.txHash },
      recipientBalance: after.value.toString(),
    },
    null,
    2,
  ),
);
