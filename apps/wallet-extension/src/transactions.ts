import {
  buildNamedCodecs,
  decodeCalldata,
  deserializeTransaction,
  serializeTransaction,
  serializeSignedTransaction,
  transactionSignaturePreimage,
  hashSignedTransaction,
  toHex0x,
} from "@groundhogchain/client";
import {
  DefaultWallet,
  DefaultWalletSpec,
  ERC20,
  ERC20Spec,
} from "@groundhogchain/client/contracts";
import {
  codec,
  serialize,
  networkHash,
  sha256Hash,
} from "@groundhogchain/protocol";
import type { Transaction } from "@groundhogchain/protocol";
import { accountOf, hex, unhex, type SecretAccount } from "./vault";
import { fail, WalletError, MAX_UNSIGNED_HEX, MAX_SIGNED_HEX } from "./policy";

const walletCodecs = buildNamedCodecs(DefaultWalletSpec.type_defs);
const tokenCodecs = buildNamedCodecs(ERC20Spec.type_defs);
export function inspectTransaction(value: string, secret: SecretAccount) {
  try {
    if (value.length > MAX_UNSIGNED_HEX)
      fail(-32602, "Transaction exceeds the signed-size budget");
    const tx = deserializeTransaction(unhex(value.slice(2)));
    if (toHex0x(serializeTransaction(tx)) !== value)
      fail(-32602, "Noncanonical transaction");
    const account = accountOf(secret);
    if (
      hex(serialize(tx.auth_claim, codec.AuthClaim)) !==
        hex(serialize(account.authClaim, codec.AuthClaim)) ||
      hex(tx.invocation.invoked_address) !== hex(account.address)
    )
      fail(
        4100,
        "Transaction authorization does not exactly match this account",
      );
    const root = tx.invocation;
    const entrypoint = hex(root.entrypoint);
    let method: string;
    if (entrypoint === hex(DefaultWallet.v0_1.execute.entrypoint))
      method = "execute";
    else if (entrypoint === hex(DefaultWallet.v0_1.deploy.entrypoint))
      method = "deploy";
    else fail(4200, "Only DefaultWallet execute and deploy are supported");
    const args = decodeCalldata(
      DefaultWalletSpec,
      "DefaultWallet",
      method,
      root.calldata,
      walletCodecs,
    );
    const calls =
      method === "execute"
        ? (args.calls as {
            target: Uint8Array;
            entrypoint: Uint8Array;
            gas_limit: bigint;
            calldata: Uint8Array;
          }[])
        : [];
    if (method === "execute" && (!calls.length || calls.length > 16))
      fail(-32602, "Expected 1 to 16 calls");
    const review = {
      method,
      entrypoint: toHex0x(root.entrypoint),
      deployment:
        method === "deploy"
          ? {
              nonce: toHex0x(args.nonce as Uint8Array),
              contractHash: toHex0x(args.contract_hash as Uint8Array),
            }
          : undefined,
      root: toHex0x(root.invoked_address),
      gas: root.gas_limit.toString(),
      calldata: toHex0x(root.calldata),
      expiry: tx.uniquifier.block_expiry_height.toString(),
      nonce: tx.uniquifier.nonce.toString(),
      deployments: tx.contracts_to_deploy.map((c) =>
        toHex0x(serialize(c, codec.Contract)),
      ),
      calls: calls.map((call) => {
        // A selector match only identifies an ABI interpretation, not the target's behavior.
        let decodedTransfer: { receiver: string; amount: string } | undefined;
        if (hex(call.entrypoint) === hex(ERC20.v0_1.transfer.entrypoint)) {
          const decoded = decodeCalldata(
            ERC20Spec,
            "ERC20",
            "transfer",
            call.calldata,
            tokenCodecs,
          );
          decodedTransfer = {
            receiver: toHex0x(decoded.receiver as Uint8Array),
            amount: String(decoded.amount),
          };
        }
        return {
          target: toHex0x(call.target),
          entrypoint: toHex0x(call.entrypoint),
          gas: call.gas_limit.toString(),
          calldata: toHex0x(call.calldata),
          decodedTransfer,
        };
      }),
    };
    return { tx, review };
  } catch (error) {
    if (error instanceof WalletError) throw error;
    fail(-32602, "Invalid transaction XDR or contract calldata");
  }
}
export async function signApproved(
  tx: Transaction,
  secret: SecretAccount,
  hash: string,
) {
  const account = accountOf(secret);
  const signer = account.signers[0]!;
  const signature = await signer.signer.sign(
    transactionSignaturePreimage(networkHash(sha256Hash(unhex(hash))), tx),
  );
  const signed = { tx, signatures: [{ public_key_id: 0n, signature }] };
  const signedTransaction = toHex0x(serializeSignedTransaction(signed));
  if (signedTransaction.length > MAX_SIGNED_HEX)
    fail(-32602, "Signed transaction exceeds 1 MiB");
  return {
    signedTransaction,
    hash: toHex0x(hashSignedTransaction(signed)),
  };
}
export type TransactionReview = ReturnType<typeof inspectTransaction>["review"];
