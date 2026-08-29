import { fromHex0x, type GroundhogClient } from "@groundhogchain/client";
import {
  calldata,
  contractAddress,
  contractEntrypointID,
  ExecResult,
  gasAmount,
  sha256Hash,
} from "@groundhogchain/protocol";
import { describe, expect, it, vi } from "vitest";

import { configuration } from "@/launch/workflow.test";
import {
  canonicalTransactionHash,
  createLocalWriteBoundary,
} from "@/transactions/local-development-wallet";

const target = {
  invoked_address: contractAddress(new Uint8Array(32).fill(7)),
  entrypoint: contractEntrypointID(new Uint8Array(8).fill(8)),
  gas_limit: gasAmount(100n),
  calldata: calldata(new Uint8Array([1, 2, 3])),
};
const wallet = {
  privateKeyHex: `0x${"01".repeat(32)}`,
  walletEntrypointHex: `0x${"02".repeat(8)}`,
};

describe("local development write boundary", () => {
  it("calls onSigned before submission and returns the committed receipt", async () => {
    const onSigned = vi.fn();
    const client = {
      getChainTip: vi.fn().mockResolvedValue({
        height: 10n,
        blockHash: sha256Hash(new Uint8Array(32).fill(3)),
      }),
      sendTransaction: vi.fn(async (signed) => {
        expect(onSigned).toHaveBeenCalledOnce();
        return canonicalTransactionHash(signed.tx);
      }),
      getTransactionReceipt: vi.fn(async (hash) => ({
        txHash: hash,
        height: 11n,
        execResult: ExecResult.ExecResultOK,
        events: [],
        returnData: new Uint8Array(),
        abortData: null,
      })),
      getTransactionStatus: vi.fn(),
    } as unknown as GroundhogClient;
    const boundary = createLocalWriteBoundary(configuration(), wallet, {
      client,
      nonce: () => 4n,
      delay: async () => {},
    });

    await expect(boundary.execute(target, { onSigned })).resolves.toMatchObject(
      {
        kind: "committedSuccess",
        receipt: { height: 11n },
      },
    );
  });

  it("observes saved evidence even when signer configuration is invalid", async () => {
    const hash = `0x${"03".repeat(32)}`;
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        txHash: sha256Hash(fromHex0x(hash)),
        height: 11n,
        execResult: ExecResult.ExecResultOK,
        events: [],
        returnData: new Uint8Array(),
        abortData: null,
      }),
      getTransactionStatus: vi.fn(),
    } as unknown as GroundhogClient;
    const boundary = createLocalWriteBoundary(
      configuration(),
      { ...wallet, privateKeyHex: "invalid" },
      { client },
    );

    await expect(boundary.observe(hash)).resolves.toMatchObject({
      kind: "committedSuccess",
      hash,
    });
  });

  it("does not trust a receipt returned for another hash", async () => {
    const hash = `0x${"03".repeat(32)}`;
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        txHash: sha256Hash(new Uint8Array(32).fill(4)),
        height: 11n,
        execResult: ExecResult.ExecResultOK,
        events: [],
        returnData: new Uint8Array(),
        abortData: null,
      }),
      getTransactionStatus: vi.fn(),
    } as unknown as GroundhogClient;
    const boundary = createLocalWriteBoundary(configuration(), wallet, {
      client,
    });

    await expect(boundary.observe(hash)).resolves.toEqual({
      kind: "indeterminate",
      hash,
      reason: "other",
    });
  });
});
