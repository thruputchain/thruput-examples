import type { GroundhogClient } from "@groundhogchain/client";
import { contractAddress, sha256Hash } from "@groundhogchain/protocol";
import { CxsWriter } from "@groundhogchain/xdr";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@/config";
import { requestFailedEvent } from "@/test/request-failed";
import { swap_if } from "@/contracts/generated/swap-handler";
import {
  createAddLiquidityOperation,
  createRemoveLiquidityOperation,
} from "@/transactions/liquidity-operation";
import { createLiquidityObserver } from "./liquidity-observer";

const BurnEvent = swap_if.v0_1.events.LiquidityBurnEvent;
type BurnEvent = swap_if.v0_1.events.LiquidityBurnEvent;
const MintEvent = swap_if.v0_1.events.LiquidityMintEvent;
type MintEvent = swap_if.v0_1.events.LiquidityMintEvent;

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
  liquidityTokenAddress: address(4),
  handlerAddress: address(3),
  driverAddress: address(2),
  tokenAAddress: address(1),
  tokenBAddress: address(10),
  tokenASymbol: "A",
  tokenBSymbol: "B",
  tokenADecimals: 6,
  tokenBDecimals: 6,
} satisfies AppConfig;

describe("liquidity observer", () => {
  it("matches a mint by request ID and records scan progress", async () => {
    const operation = createAddLiquidityOperation(config, {
      amountsDesired: [10n, 20n],
      amountsMin: [9n, 18n],
      estimatedLiquidity: 10n,
      liquidityBalanceBefore: 1n,
      reservesBefore: [100n, 200n],
    });
    operation.status = "queued";
    operation.requestId = hex(30);
    operation.receiptBlock = "8";
    const getEvents = vi.fn().mockResolvedValue({
      events: [identified(mintEvent(new Uint8Array(32).fill(30)), 10n)],
      cursor: new Uint8Array(),
      latestBlock: 11n,
      oldestBlock: 1n,
    });

    const result = await createLiquidityObserver(
      config,
      rpcClient(getEvents),
    ).scan(operation);

    expect(result).toMatchObject({
      status: "executed",
      terminalBlock: "10",
      observedThroughBlock: "11",
      result: {
        transactionHash: hex(40),
        blockHeight: "10",
        liquidityMinted: "10",
      },
    });
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        anchor: { height: 8n },
        order: "ascending",
      }),
    );
  });

  it("matches request failure and rejects under-minimum burn evidence", async () => {
    const failedOperation = queuedRemove();
    const failedClient = rpcClient(
      vi.fn().mockResolvedValue({
        events: [identified(failedEvent(new Uint8Array(32).fill(30)), 10n)],
        cursor: new Uint8Array(),
        latestBlock: 10n,
        oldestBlock: 1n,
      }),
    );
    await expect(
      createLiquidityObserver(config, failedClient).scan(failedOperation),
    ).resolves.toMatchObject({ status: "failed", terminalBlock: "10" });

    const invalidClient = rpcClient(
      vi.fn().mockResolvedValue({
        events: [
          identified(burnEvent(new Uint8Array(32).fill(30), [1n, 2n]), 10n),
        ],
        cursor: new Uint8Array(),
        latestBlock: 10n,
        oldestBlock: 1n,
      }),
    );
    await expect(
      createLiquidityObserver(config, invalidClient).scan(queuedRemove()),
    ).rejects.toThrow("invalid terminal burn evidence");
  });
});

function rpcClient(
  getEvents: Pick<GroundhogClient, "getEvents">["getEvents"],
): Pick<GroundhogClient, "getEvents"> {
  return { getEvents };
}

function mintEvent(requestId: Uint8Array) {
  const writer = new CxsWriter();
  writer.writeUint128(10n);
  writer.writeUint32(1n);
  writer.writeFixedOpaque(requestId, 32);
  return {
    contractAddress: config.handlerAddress,
    topics: [MintEvent.signature, config.accountAddress, config.accountAddress],
    data: writer.finish(),
  };
}

function burnEvent(requestId: Uint8Array, amounts: readonly [bigint, bigint]) {
  const writer = new CxsWriter();
  writer.writeUint128(amounts[0]);
  writer.writeUint128(amounts[1]);
  writer.writeUint32(1n);
  writer.writeFixedOpaque(requestId, 32);
  return {
    contractAddress: config.handlerAddress,
    topics: [BurnEvent.signature, config.accountAddress, config.accountAddress],
    data: writer.finish(),
  };
}

function failedEvent(requestId: Uint8Array) {
  return requestFailedEvent(config.driverAddress, requestId);
}

function identified(
  event:
    | ReturnType<typeof mintEvent>
    | ReturnType<typeof burnEvent>
    | ReturnType<typeof failedEvent>,
  blockHeight: bigint,
) {
  return {
    txHash: sha256Hash(new Uint8Array(32).fill(40)),
    blockHeight,
    sequenceNumber: 1,
    event,
  };
}

function queuedRemove() {
  const operation = createRemoveLiquidityOperation(config, {
    liquidity: 10n,
    amountsMin: [4n, 8n],
  });
  operation.status = "queued";
  operation.requestId = hex(30);
  operation.receiptBlock = "8";
  return operation;
}
