// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  createPubkeyAccount,
  hashSignedTransaction,
  Ed25519Signer,
  toBase58,
  type TransactionReceipt,
} from "@thruputchain/client";
import {
  createTransaction,
  signTransaction,
} from "@thruputchain/client/transaction";
import { ERC20 } from "@thruputchain/client/contracts";
import {
  blockHeight,
  gasAmount,
  HOG_ADDRESS,
  networkHash,
  sha256Hash,
} from "@thruputchain/protocol";
import { submitSeedTransaction } from "./seed-transaction.ts";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const signer = new Ed25519Signer(new Uint8Array(32).fill(1));
  const account = createPubkeyAccount({ signer });
  const invocation = ERC20.v0_1.transfer.invocation(
    HOG_ADDRESS,
    gasAmount(1_000_000n),
    { receiver: account.address, amount: 1n },
  );
  const tx = createTransaction({
    invocation,
    uniquifier: { nonce: 1n, block_expiry_height: blockHeight(100n) },
    contracts_to_deploy: [],
    auth_claim: account.authClaim,
  });
  const signed = await signTransaction(
    tx,
    [{ signer, publicKeyId: 0n }],
    networkHash(sha256Hash(new Uint8Array(32))),
  );
  const hash = hashSignedTransaction(signed);
  const receipt: TransactionReceipt = {
    transactionHash: hash,
    blockHeight: 10n,
    execution: { result: "return" as const, returnData: new Uint8Array() },
    gasUsed: 0n,
    events: [],
  };
  const wallet = {
    prepareExecution: vi.fn(async () => tx),
    signTransaction: vi.fn(async () => signed),
    sendTransaction: vi.fn(async () => ({
      transactionHash: hash,
      admission: "accepted" as const,
    })),
    waitForTransactionReceipt: vi.fn(async () => receipt),
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    wallet,
    hash,
    receipt,
    request: { invocation, gasLimit: gasAmount(1_000_000n) },
    log,
  };
}

it("prints the canonical hash before submission and confirms the receipt", async () => {
  const f = await fixture();
  f.wallet.sendTransaction.mockImplementation(async () => {
    expect(f.log).toHaveBeenCalledWith(
      `Submitting transfer: ${toBase58(f.hash)}`,
    );
    return { transactionHash: f.hash, admission: "accepted" as const };
  });
  expect(await submitSeedTransaction(f.wallet, "transfer", f.request)).toBe(
    f.receipt,
  );
  expect(f.wallet.sendTransaction).toHaveBeenCalledOnce();
});

it.each(["sendTransaction", "waitForTransactionReceipt"] as const)(
  "stops without resubmitting when %s has an uncertain outcome",
  async (method) => {
    const f = await fixture();
    f.wallet[method].mockRejectedValue(new Error("response lost"));
    await expect(
      submitSeedTransaction(f.wallet, "transfer", f.request),
    ).rejects.toThrow("response lost");
    expect(f.wallet.signTransaction).toHaveBeenCalledOnce();
    expect(f.wallet.sendTransaction).toHaveBeenCalledOnce();
    expect(f.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Completed"),
    );
  },
);

it("rejects a mismatched receipt and a reverted transaction", async () => {
  const f = await fixture();
  f.wallet.waitForTransactionReceipt.mockResolvedValue({
    ...f.receipt,
    transactionHash: sha256Hash(new Uint8Array(32)),
  });
  await expect(
    submitSeedTransaction(f.wallet, "transfer", f.request),
  ).rejects.toThrow("receipt hash mismatched");
  f.wallet.waitForTransactionReceipt.mockResolvedValue({
    ...f.receipt,
    execution: { result: "abort" as const, abortData: new Uint8Array() },
  });
  await expect(
    submitSeedTransaction(f.wallet, "transfer", f.request),
  ).rejects.toThrow("Transaction failed");
});
