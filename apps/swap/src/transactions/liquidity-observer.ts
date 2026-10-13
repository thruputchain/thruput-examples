import {
  bytesEqual,
  toHex0x,
  type EventPage,
  type ThruputClient,
  type IdentifiedEvent,
} from "@thruputchain/client";

import type { AppConfig } from "@/config";
import { batch_driver } from "@/contracts/generated/swap-driver";
import { swap_if } from "@/contracts/generated/swap-handler";
import type { LiquidityOperation } from "@/transactions/liquidity-operation";

const RequestFailed = batch_driver.v0_1.events.RequestFailed;
const { LiquidityBurnEvent: BurnEvent, LiquidityMintEvent: MintEvent } =
  swap_if.v0_1.events;
type RequestFailed = batch_driver.v0_1.events.RequestFailed;

export interface LiquidityObserver {
  scan(operation: LiquidityOperation): Promise<LiquidityOperation>;
}

export function createLiquidityObserver(
  config: AppConfig,
  client: Pick<ThruputClient, "getEvents">,
): LiquidityObserver {
  return {
    async scan(operation) {
      if (
        operation.status !== "queued"
        || operation.requestId === null
        || operation.receiptBlock === null
      ) return operation;
      const requestBlock = BigInt(operation.receiptBlock);
      const anchorHeight = operation.observedThroughBlock === null
        ? requestBlock
        : BigInt(operation.observedThroughBlock) + 1n;
      let cursor: Uint8Array | undefined;
      let observedThrough = BigInt(operation.observedThroughBlock ?? operation.receiptBlock);
      let oldestRetained: bigint | null = null;
      let terminal: LiquidityOperation | null = null;
      const seenCursors = new Set<string>();
      const seenEvents = new Set<string>();

      for (;;) {
        const page: EventPage = await client.getEvents({
          filters: [
            MintEvent.filter({
              contractAddresses: [config.handlerAddress],
            }),
            BurnEvent.filter({
              contractAddresses: [config.handlerAddress],
            }),
            RequestFailed.filter({ contractAddresses: [config.driverAddress] }),
          ],
          order: "ascending",
          anchor: { height: anchorHeight },
          ...(cursor === undefined ? {} : { cursor }),
          limit: 200,
        });
        if (page.latestBlock > observedThrough) observedThrough = page.latestBlock;
        if (oldestRetained === null || page.oldestBlock > oldestRetained) {
          oldestRetained = page.oldestBlock;
        }
        for (const identified of page.events) {
          const eventKey = `${toHex0x(identified.txHash)}:${identified.sequenceNumber}`;
          if (seenEvents.has(eventKey)) continue;
          seenEvents.add(eventKey);
          const matched = matchTerminal(config, operation, identified);
          if (matched === null) continue;
          if (terminal !== null) {
            throw new Error("Event history contains duplicate terminal liquidity events");
          }
          terminal = matched;
        }
        if (page.cursor.length === 0) break;
        const cursorKey = toHex0x(page.cursor);
        if (seenCursors.has(cursorKey)) {
          throw new Error("Event query returned a repeated pagination cursor");
        }
        seenCursors.add(cursorKey);
        cursor = page.cursor;
      }

      if (terminal !== null) {
        return { ...terminal, observedThroughBlock: observedThrough.toString() };
      }
      if (oldestRetained !== null && oldestRetained > anchorHeight) {
        throw new Error("Event history no longer covers this unresolved liquidity request");
      }
      return {
        ...operation,
        observedThroughBlock: observedThrough.toString(),
        updatedAt: Date.now(),
      };
    },
  };
}

function matchTerminal(
  config: AppConfig,
  operation: LiquidityOperation,
  identified: IdentifiedEvent,
): LiquidityOperation | null {
  if (identified.blockHeight < BigInt(operation.receiptBlock!)) return null;
  const event = identified.event;
  if (bytesEqual(event.contractAddress, config.driverAddress)) {
    const failed = RequestFailed.decode(event);
    if (
      failed === null
      || toHex0x(failed.topics.request_id) !== operation.requestId
    ) return null;
    return {
      ...operation,
      status: "failed",
      terminalBlock: identified.blockHeight.toString(),
      result: null,
      updatedAt: Date.now(),
    };
  }
  if (!bytesEqual(event.contractAddress, config.handlerAddress)) return null;

  if (operation.kind === "add") {
    const minted = MintEvent.decode(event);
    if (
      minted === null
      || minted.fields.request_id === null
      || toHex0x(minted.fields.request_id) !== operation.requestId
    ) return null;
    if (
      !bytesEqual(minted.topics.sender, config.accountAddress)
      || !bytesEqual(minted.topics.recipient, config.accountAddress)
      || minted.fields.amount_minted <= 0n
    ) throw new Error("Event history contains invalid terminal mint evidence");
    return {
      ...operation,
      status: "executed",
      terminalBlock: identified.blockHeight.toString(),
      result: {
        transactionHash: toHex0x(identified.txHash),
        blockHeight: identified.blockHeight.toString(),
        liquidityMinted: minted.fields.amount_minted.toString(),
        recipientVerified: true,
        amountsDeposited: null,
      },
      updatedAt: Date.now(),
    };
  }

  const burned = BurnEvent.decode(event);
  const minimums = operation.intent.amountsMin.map(BigInt);
  if (
    burned === null
    || burned.fields.request_id === null
    || toHex0x(burned.fields.request_id) !== operation.requestId
  ) return null;
  if (
    !bytesEqual(burned.topics.sender, config.accountAddress)
    || !bytesEqual(burned.topics.recipient, config.accountAddress)
    || burned.fields.amounts_redeemed[0] < minimums[0]!
    || burned.fields.amounts_redeemed[1] < minimums[1]!
  ) throw new Error("Event history contains invalid terminal burn evidence");
  return {
    ...operation,
    status: "executed",
    terminalBlock: identified.blockHeight.toString(),
    result: {
      transactionHash: toHex0x(identified.txHash),
      blockHeight: identified.blockHeight.toString(),
      amountsRedeemed: burned.fields.amounts_redeemed.map(String) as unknown as readonly [string, string],
    },
    updatedAt: Date.now(),
  };
}
