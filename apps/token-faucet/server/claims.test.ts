import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPubkeyAccount,
  hashSignedTransaction,
  PrivateKeySigner,
  toHex0x,
  type TransactionReceipt,
} from "@groundhogchain/client";
import {
  createTransaction,
  signTransaction,
} from "@groundhogchain/client/transaction";
import { ERC20 } from "@groundhogchain/client/contracts";
import {
  blockHeight,
  ExecResult,
  gasAmount,
  networkHash,
  sha256Hash,
  type Invocation,
} from "@groundhogchain/protocol";
import { ClaimService } from "./claims";
import type { connectChain } from "./chain";
import { canonicalAddress } from "../src/domain";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const token = {
  address: `0x${"02".repeat(32)}`,
  name: "Acorn",
  symbol: "ACORN",
  decimals: 6,
};
const recipient = `0x${"03".repeat(32)}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "token-faucet-"));
  directories.push(directory);
  const signer = new PrivateKeySigner(new Uint8Array(32).fill(1));
  const account = createPubkeyAccount({ signer });
  const signed = await signTransaction(
    createTransaction({
      invocation: ERC20.transfer.invocation(
        account.address,
        gasAmount(1_000_000n),
        { receiver: account.address, amount: 1n },
      ),
      uniquifier: { nonce: 1n, block_expiry_height: blockHeight(100n) },
      contracts_to_deploy: [],
      auth_claim: account.authClaim,
    }),
    [{ signer, publicKeyId: 0n }],
    networkHash(sha256Hash(new Uint8Array(32).fill(2))),
  );
  const hash = hashSignedTransaction(signed);
  const receipt: TransactionReceipt = {
    txHash: hash,
    height: 10n,
    execResult: ExecResult.ExecResultOK,
    events: [],
    returnData: null,
    abortData: null,
  };
  const client = {
    getTransactionReceipt: vi.fn(
      async (): Promise<TransactionReceipt | null> => null,
    ),
    getTransactionStatus: vi.fn(async () => ({ status: "pending" as const })),
    getChainTip: vi.fn(async () => ({
      height: blockHeight(50n),
      blockHash: hash,
    })),
    sendTransaction: vi.fn(async () => hash),
    waitForTransactionReceipt: vi.fn(async () => receipt),
  };
  const wallet = {
    prepareExecution: vi.fn(
      async (_input: { invocation: Invocation }) => signed.tx,
    ),
    signTransaction: vi.fn(async () => signed),
  };
  const chain = {
    client,
    wallet,
    verifyNetwork: vi.fn(async () => {}),
  } as unknown as Awaited<ReturnType<typeof connectChain>>;
  return {
    directory,
    client,
    wallet,
    receipt,
    chain,
    service: new ClaimService(directory, [token], chain),
  };
}

it("serializes concurrent claims and preserves the limit after restart", async () => {
  const f = await fixture();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => f.service.claim(token.address, recipient)),
  );
  expect(results.every((result) => result.state === "claimed")).toBe(true);
  expect(f.client.sendTransaction).toHaveBeenCalledOnce();
  const restarted = new ClaimService(f.directory, [token], f.chain);
  expect(
    await restarted.claim(
      token.address,
      recipient.toUpperCase().replace("0X", "0x"),
    ),
  ).toEqual(results[0]);
  expect(f.client.sendTransaction).toHaveBeenCalledOnce();
});

it("requests exactly ten display units using token precision", async () => {
  const f = await fixture();
  await f.service.claim(token.address, recipient);
  const { addressFromHex } = await import("@groundhogchain/client");
  expect(f.wallet.prepareExecution.mock.calls[0]?.[0].invocation).toEqual(
    ERC20.transfer.invocation(
      addressFromHex(token.address),
      gasAmount(1_000_000n),
      { receiver: addressFromHex(recipient), amount: 10_000_000n },
    ),
  );
});

it("recovers a lost send response without signing another transfer", async () => {
  const f = await fixture();
  f.client.sendTransaction.mockRejectedValueOnce(new Error("Response lost"));
  await expect(f.service.claim(token.address, recipient)).rejects.toThrow(
    "Response lost",
  );
  expect((await f.service.status(token.address, recipient)).state).toBe(
    "pending",
  );
  f.client.getTransactionReceipt.mockResolvedValue(f.receipt);
  const restarted = new ClaimService(f.directory, [token], f.chain);
  expect(await restarted.claim(token.address, recipient)).toEqual({
    state: "claimed",
    transactionHash: toHex0x(f.receipt.txHash),
  });
  expect(f.wallet.signTransaction).toHaveBeenCalledOnce();
});

it("rejects unknown tokens and invalid recipients before signing", async () => {
  const f = await fixture();
  await expect(f.service.claim(recipient, recipient)).rejects.toThrow(
    "Unknown",
  );
  await expect(f.service.claim(token.address, "0x00")).rejects.toThrow("valid");
  await expect(
    f.service.claim(token.address, `0x${"00".repeat(32)}`),
  ).rejects.toThrow("zero");
  expect(f.wallet.signTransaction).not.toHaveBeenCalled();
});

it("rejects filesystem paths as recipient addresses", () => {
  expect(() => canonicalAddress("../signer.key")).toThrow();
});
