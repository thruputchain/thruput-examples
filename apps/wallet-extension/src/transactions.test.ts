import { describe, expect, it } from "vitest";
import {
  defaultWalletAdapter,
  prepareTransaction,
  serializeTransaction,
  deserializeSignedTransaction,
  toHex0x,
  hashSignedTransaction,
  transactionSignaturePreimage,
} from "@groundhogchain/client";
import { ERC20, DefaultWallet } from "@groundhogchain/client/contracts";
import {
  blockHeight,
  contractAddress,
  gasAmount,
  networkHash,
  sha256Hash,
  fixedBytes,
} from "@groundhogchain/protocol";
import { verifyAsync } from "@noble/ed25519";
import { accountOf, newVault, unhex } from "./vault";
import { inspectTransaction, signApproved } from "./transactions";
import { parseAmount, requireAirdropSuccess } from "./network";
import { requestSchema, MAX_UNSIGNED_BYTES, MAX_SIGNED_BYTES } from "./policy";
const secret = newVault(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
).accounts[0]!;
export async function fixtureTransaction() {
  const account = accountOf(secret);
  return prepareTransaction(
    { getChainTip: async () => ({ height: blockHeight(1n) }) as never },
    account,
    {
      nonce: 4n,
      invocation: defaultWalletAdapter.createRootInvocation(account.address, {
        gasLimit: gasAmount(100000n),
        invocation: ERC20.transfer.invocation(
          contractAddress(new Uint8Array(32).fill(1)),
          gasAmount(50000n),
          { receiver: account.address, amount: 10n },
        ),
      }),
    },
  );
}
describe("transaction validation and signing", () => {
  it("supports the full signed 1 MiB boundary with the actual 76-byte signature overhead", async () => {
    const tx = await fixtureTransaction();
    const call = {
      target: accountOf(secret).address,
      entrypoint: fixedBytes(new Uint8Array(8).fill(9), 8),
      gas_limit: 1n,
      calldata: new Uint8Array(0),
    };
    const root = () =>
      DefaultWallet.execute.invocation(
        accountOf(secret).address,
        gasAmount(100000n),
        { calls: [call] },
      );
    tx.invocation = root();
    call.calldata = new Uint8Array(
      MAX_UNSIGNED_BYTES - serializeTransaction(tx).length,
    );
    tx.invocation = root();
    call.calldata = new Uint8Array(
      call.calldata.length -
        (serializeTransaction(tx).length - MAX_UNSIGNED_BYTES),
    );
    tx.invocation = root();
    const encoded = toHex0x(serializeTransaction(tx));
    expect((encoded.length - 2) / 2).toBe(MAX_UNSIGNED_BYTES);
    inspectTransaction(encoded, secret);
    const signed = await signApproved(tx, secret, "00".repeat(32));
    expect((signed.signedTransaction.length - 2) / 2).toBe(MAX_SIGNED_BYTES);
    expect(() =>
      requestSchema({
        method: "submitTransaction",
        params: {
          account: toHex0x(accountOf(secret).address),
          networkHash: "00".repeat(32),
          signedTransaction: signed.signedTransaction,
        },
      }),
    ).not.toThrow();
    expect(() => inspectTransaction(encoded + "00000000", secret)).toThrow(
      "budget",
    );
  });
  it("enforces the current native DefaultWallet limit of sixteen calls", async () => {
    const tx = await fixtureTransaction();
    const call = {
      target: accountOf(secret).address,
      entrypoint: fixedBytes(new Uint8Array(8).fill(9), 8),
      gas_limit: 1n,
      calldata: new Uint8Array(0),
    };
    tx.invocation = DefaultWallet.execute.invocation(
      accountOf(secret).address,
      gasAmount(100000n),
      { calls: Array.from({ length: 16 }, () => call) },
    );
    expect(
      inspectTransaction(toHex0x(serializeTransaction(tx)), secret).review
        .calls,
    ).toHaveLength(16);
    tx.invocation = DefaultWallet.execute.invocation(
      accountOf(secret).address,
      gasAmount(100000n),
      { calls: Array.from({ length: 17 }, () => call) },
    );
    expect(() =>
      inspectTransaction(toHex0x(serializeTransaction(tx)), secret),
    ).toThrow("1 to 16");
  });
  it("decodes root and transfer, signs only network-bound canonical bytes", async () => {
    const tx = await fixtureTransaction(),
      encoded = toHex0x(serializeTransaction(tx));
    expect(
      inspectTransaction(encoded, secret).review.calls[0]!.transfer?.amount,
    ).toBe("10");
    const result = await signApproved(tx, secret, "00".repeat(32));
    const signed = deserializeSignedTransaction(
      unhex(result.signedTransaction.slice(2)),
    );
    expect(result.hash).toBe(toHex0x(hashSignedTransaction(signed)));
    const signature = signed.signatures[0]!.signature.ed25519;
    const key = accountOf(secret).authClaim.pubkey_preimage.pubkey.ed25519;
    expect(
      await verifyAsync(
        signature,
        transactionSignaturePreimage(
          networkHash(sha256Hash(new Uint8Array(32))),
          tx,
        ),
        key,
      ),
    ).toBe(true);
    expect(
      await verifyAsync(
        signature,
        transactionSignaturePreimage(
          networkHash(sha256Hash(new Uint8Array(32).fill(1))),
          tx,
        ),
        key,
      ),
    ).toBe(false);
  });
  it("rejects root substitution, nonce/auth substitution, and trailing bytes", async () => {
    const tx = await fixtureTransaction();
    tx.invocation.invoked_address = contractAddress(new Uint8Array(32));
    expect(() =>
      inspectTransaction(toHex0x(serializeTransaction(tx)), secret),
    ).toThrow("authorization");
    const other = await fixtureTransaction();
    if ("pubkey_preimage" in other.auth_claim)
      other.auth_claim.pubkey_preimage.nonce = 1n;
    expect(() =>
      inspectTransaction(toHex0x(serializeTransaction(other)), secret),
    ).toThrow("authorization");
    const valid = await fixtureTransaction();
    expect(() =>
      inspectTransaction(`${toHex0x(serializeTransaction(valid))}00`, secret),
    ).toThrow();
  });
});
describe("amount and airdrop outcomes", () => {
  it("never rounds amounts through floating point", () => {
    expect(parseAmount("123456789.1234567", 7)).toBe(1234567891234567n);
    for (const value of ["1e5", "-1", "0", "1.12345678"])
      expect(() => parseAmount(value, 7)).toThrow();
  });
  it("does not confuse a committed airdrop with successful execution", () => {
    expect(() =>
      requireAirdropSuccess({ status: { result: "ok" } }),
    ).not.toThrow();
    expect(() =>
      requireAirdropSuccess({ status: { result: "reverted" } }),
    ).toThrow("execution reverted");
  });
});
