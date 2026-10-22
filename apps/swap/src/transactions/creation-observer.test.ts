import { toBase58 } from "@thruputchain/client";
import type { ThruputClient } from "@thruputchain/client";
import { contractAddress, sha256Hash } from "@thruputchain/protocol";
import { CxsWriter } from "@thruputchain/xdr";
import { describe, expect, it, vi } from "vitest";

import type { GlobalConfig } from "@/config";
import { swap_if } from "@/contracts/generated/swap-handler";
import type { PoolCreationReview } from "@/pools/pool-creation";
import { createCreationWorkflow } from "@/transactions/creation-workflow";
import {
  applyCreationReceipt,
  createCreationObserver,
} from "./creation-observer";
import { requestFailedEvent } from "@/test/request-failed";

const MintEvent = swap_if.v0_1.events.LiquidityMintEvent;
type MintEvent = swap_if.v0_1.events.LiquidityMintEvent;

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) =>
  `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const id = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkId: toBase58(new Uint8Array(32).fill(0x00)),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeTokenAddress: address(6),
} satisfies GlobalConfig;

describe("creation observer", () => {
  it("treats the new diagnostic failure event as terminal in history and receipts", async () => {
    const workflow = queuedWorkflow();
    const event = requestFailedEvent(address(23), new Uint8Array(32).fill(30));
    const txHash = sha256Hash(new Uint8Array(32).fill(40));
    const getEvents = vi.fn().mockResolvedValue({
      events: [
        { event, blockHeight: 10n, transactionHash: txHash, sequenceNumber: 1 },
      ],
      nextCursor: null,
      latestIndexedBlockHeight: 11n,
      oldestIndexedBlockHeight: 1n,
    });
    await expect(
      createCreationObserver(config, rpcClient(getEvents)).scan(workflow),
    ).resolves.toMatchObject({ status: "failed", terminalBlock: "10" });
    expect(
      applyCreationReceipt(workflow, {
        transactionHash: txHash,
        blockHeight: 10n,
        execution: { result: "return" as const, returnData: new Uint8Array() },
        gasUsed: 0n,
        events: [event],
      }),
    ).toMatchObject({ status: "failed", terminalBlock: "10" });
  });
  it("recovers a request-correlated handler mint from event history", async () => {
    const workflow = queuedWorkflow();
    const getEvents = vi.fn().mockResolvedValue({
      events: [
        {
          event: mintEvent(new Uint8Array(32).fill(30)),
          blockHeight: 10n,
          transactionHash: sha256Hash(new Uint8Array(32).fill(40)),
          sequenceNumber: 1,
        },
      ],
      nextCursor: null,
      latestIndexedBlockHeight: 11n,
      oldestIndexedBlockHeight: 1n,
    });

    await expect(
      createCreationObserver(config, rpcClient(getEvents)).scan(workflow),
    ).resolves.toMatchObject({
      status: "executed",
      terminalBlock: "10",
      observedThroughBlock: "11",
    });
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        start: {
          order: "ascending",
          anchor: { kind: "atHeight", blockHeight: 8n },
        },
      }),
    );
  });
});

function queuedWorkflow() {
  const workflow = createCreationWorkflow(config, review(), 1);
  workflow.status = "queued";
  workflow.pool = {
    liquidityToken: id(21),
    handler: id(22),
    driver: id(23),
  };
  workflow.requestId = hex(30);
  workflow.enqueueReceiptBlock = "8";
  return workflow;
}

function review(): PoolCreationReview {
  const token = (byte: number) => ({
    address: address(byte),
    addressBase58: id(byte),
    name: `Token ${byte}`,
    symbol: `T${byte}`,
    decimals: 0,
    balance: 10n,
    allowance: 0n,
    amount: 1n,
    approvalDifference: 1n,
  });
  return {
    token0: token(1),
    token1: token(2),
    pool: null,
    nativeTokenBalance: 300n,
    nativeTokenAllowance: 0n,
    fundingMinimum: 50n,
    fundingPerContract: 100n,
    totalFunding: 300n,
    fundingApprovalDifference: 300n,
    initialLiquidity: 1n,
    readHeight: 1n,
  };
}

function mintEvent(requestId: Uint8Array) {
  const writer = new CxsWriter();
  writer.writeUint128(10n);
  writer.writeUint32(1n);
  writer.writeFixedOpaque(requestId, 32);
  return {
    address: address(22),
    topics: [MintEvent.signature, config.accountAddress, config.accountAddress],
    data: writer.finish(),
  };
}

function rpcClient(
  getEvents: Pick<ThruputClient, "getEvents">["getEvents"],
): Pick<ThruputClient, "getEvents"> {
  return { getEvents };
}
