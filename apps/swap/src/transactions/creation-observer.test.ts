import type { GroundhogClient } from "@groundhogchain/client";
import {
  contractAddress,
  ExecResult,
  sha256Hash,
} from "@groundhogchain/protocol";
import { CxsWriter } from "@groundhogchain/xdr";
import { describe, expect, it, vi } from "vitest";

import type { GlobalConfig } from "@/config";
import { MintEvent } from "@/contracts/generated/swap-handler";
import type { PoolCreationReview } from "@/pools/pool-creation";
import { createCreationWorkflow } from "@/transactions/creation-workflow";
import {
  applyCreationReceipt,
  createCreationObserver,
} from "./creation-observer";
import { requestFailedEvent } from "@/test/request-failed";

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const hex = (byte: number) =>
  `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  networkIdHex: "00".repeat(32),
  accountAddress: address(9),
  routerAddress: address(8),
  factoryAddress: address(7),
  nativeHogAddress: address(6),
} satisfies GlobalConfig;

describe("creation observer", () => {
  it("treats the new diagnostic failure event as terminal in history and receipts", async () => {
    const workflow = queuedWorkflow();
    const event = requestFailedEvent(address(23), new Uint8Array(32).fill(30));
    const txHash = sha256Hash(new Uint8Array(32).fill(40));
    const getEvents = vi.fn().mockResolvedValue({
      events: [{ event, blockHeight: 10n, txHash, sequenceNumber: 1 }],
      cursor: new Uint8Array(),
      latestBlock: 11n,
      oldestBlock: 1n,
    });
    await expect(
      createCreationObserver(config, rpcClient(getEvents)).scan(workflow),
    ).resolves.toMatchObject({ status: "failed", terminalBlock: "10" });
    expect(
      applyCreationReceipt(workflow, {
        txHash,
        height: 10n,
        execResult: ExecResult.ExecResultOK,
        events: [event],
        returnData: null,
        abortData: null,
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
          txHash: sha256Hash(new Uint8Array(32).fill(40)),
          sequenceNumber: 1,
        },
      ],
      cursor: new Uint8Array(),
      latestBlock: 11n,
      oldestBlock: 1n,
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
        anchor: { height: 8n },
        order: "ascending",
      }),
    );
  });
});

function queuedWorkflow() {
  const workflow = createCreationWorkflow(config, review(), 1);
  workflow.status = "queued";
  workflow.pool = {
    liquidityToken: hex(21),
    handler: hex(22),
    driver: hex(23),
  };
  workflow.requestId = hex(30);
  workflow.enqueueReceiptBlock = "8";
  return workflow;
}

function review(): PoolCreationReview {
  const token = (byte: number) => ({
    address: address(byte),
    addressHex: hex(byte),
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
    nativeHogBalance: 300n,
    nativeHogAllowance: 0n,
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
    contractAddress: address(22),
    topics: [MintEvent.signature, config.accountAddress, config.accountAddress],
    data: writer.finish(),
  };
}

function rpcClient(
  getEvents: Pick<GroundhogClient, "getEvents">["getEvents"],
): Pick<GroundhogClient, "getEvents"> {
  return { getEvents };
}
