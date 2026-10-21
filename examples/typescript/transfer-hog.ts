import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createPubkeyAccount,
  createWalletClient,
  parseUnits,
  PrivateKeySigner,
  toBase58,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import { gasAmount, HOG_ADDRESS } from "@thruputchain/protocol";
import { createLocalClient } from "./local-client.ts";
import { waitForView } from "./wait-for-view.ts";

const client = await createLocalClient();
// Disposable local accounts: neither private key is printed or saved.
const sender = createPubkeyAccount({
  signer: new PrivateKeySigner(randomBytes(32)),
});
const recipient = createPubkeyAccount({
  signer: new PrivateKeySigner(randomBytes(32)),
});
const wallet = createWalletClient({ client, account: sender });

// Fund both accounts so a tiny transfer need not pay for a new balance row.
await wallet.requestAirdrop();
const recipientFunding = await client.requestAirdrop({
  recipient: recipient.address,
});
const before = await waitForView(() =>
  ERC20.v0_1.getBalanceOf.view({
    client,
    address: HOG_ADDRESS,
    caller: sender.address,
    args: { addr: recipient.address },
    minStateBlockHeight: recipientFunding.blockHeight,
  }),
);

const amount = parseUnits("0.0001", 7); // HOG has seven decimal places.
const { transactionHash, receipt } = await wallet.executeAndWait(
  {
    invocation: ERC20.v0_1.transfer.invocation(
      HOG_ADDRESS,
      gasAmount(500_000n),
      {
        receiver: recipient.address,
        amount,
      },
    ),
    gasLimit: gasAmount(1_000_000n),
  },
  { timeoutMs: 60_000 },
);
const after = await waitForView(() =>
  ERC20.v0_1.getBalanceOf.view({
    client,
    address: HOG_ADDRESS,
    caller: sender.address,
    args: { addr: recipient.address },
    minStateBlockHeight: receipt.blockHeight,
  }),
);
assert.equal(
  after.value,
  before.value + amount,
  "Recipient balance did not increase as expected",
);

console.log(
  JSON.stringify(
    {
      sender: toBase58(sender.address),
      recipient: toBase58(recipient.address),
      txHash: toBase58(transactionHash),
      transferredRaw: amount.toString(),
      recipientBalance: after.value.toString(),
    },
    null,
    2,
  ),
);
