import assert from "node:assert/strict";
import {
  createPubkeyAccount,
  createWalletClient,
  Ed25519Signer,
  fromHex0x,
  hashSignedTransaction,
  parseAddress,
  parseUnits,
  serializeSignedTransaction,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import { ERC20, ERC20Metadata } from "@thruputchain/client/contracts";
import { gasAmount } from "@thruputchain/protocol";
import { createLocalClient } from "./local-client.ts";
import { waitForView } from "./wait-for-view.ts";

// Use a disposable local account that already holds this test token.
// The faucet can supply it. Never use a production or hosted faucet key here.
const client = await createLocalClient();
const key = process.env.TOKEN_SENDER_PRIVATE_KEY;
assert(key && /^0x[0-9a-fA-F]{64}$/.test(key), "Set TOKEN_SENDER_PRIVATE_KEY");
const token = parseAddress(process.env.TOKEN_ADDRESS!);
const receiver = parseAddress(process.env.TOKEN_RECIPIENT!);
const account = createPubkeyAccount({
  signer: new Ed25519Signer(fromHex0x(key)),
});
const wallet = createWalletClient({ client, account });
const decimals = (
  await ERC20Metadata.v0_1.decimals.view({ client, address: token })
).value;
const amount = parseUnits(process.env.TOKEN_AMOUNT || "1", Number(decimals));
assert(amount > 0n, "Amount must be positive");
const before = await ERC20.v0_1.getBalanceOf.view({
  client,
  address: token,
  args: { addr: receiver },
});
const transaction = await wallet.prepareExecution({
  invocation: ERC20.v0_1.transfer.invocation(token, gasAmount(5_000_000n), {
    receiver,
    amount,
  }),
  gasLimit: gasAmount(10_000_000n),
});
const signed = await wallet.signTransaction(transaction);
const hash = hashSignedTransaction(signed);
const bytes = serializeSignedTransaction(signed);
// Save this output before broadcast. If submission times out, inspect this hash;
// do not run the script again to recover the transfer.
console.log(
  JSON.stringify({
    network: toBase58(client.network.networkHash),
    sender: toBase58(account.address),
    hash: toBase58(hash),
    signedTransaction: toHex0x(bytes),
  }),
);
const sent = await wallet.sendTransaction({ signedTransaction: bytes });
assert.equal(toBase58(sent.transactionHash), toBase58(hash));
const receipt = await wallet.waitForTransactionReceipt(hash, {
  timeoutMs: 60_000,
});
assert(
  "result" in receipt.execution && receipt.execution.result === "return",
  "Transfer did not succeed",
);
const after = await waitForView(() =>
  ERC20.v0_1.getBalanceOf.view({
    client,
    address: token,
    args: { addr: receiver },
    minStateBlockHeight: receipt.blockHeight,
  }),
);
assert.equal(after.value, before.value + amount);
console.log(
  JSON.stringify({
    transferredRaw: String(amount),
    recipientBalance: String(after.value),
  }),
);
