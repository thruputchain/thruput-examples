import {
  addressFromBase58,
  bytesEqual,
  type EventPage,
  type IdentifiedEvent,
  type ThruputClient,
  toBase58,
  toHex0x,
  type TransactionReceipt,
} from "@thruputchain/client";

import type { GlobalConfig } from "@/config";
import { batch_driver } from "@/contracts/generated/swap-driver";
import { swap_if } from "@/contracts/generated/swap-handler";
import type { CreationWorkflow } from "@/transactions/creation-workflow";

const RequestFailed = batch_driver.v0_1.events.RequestFailed;
const MintEvent = swap_if.v0_1.events.LiquidityMintEvent;
type RequestFailed = batch_driver.v0_1.events.RequestFailed;

export interface CreationObserver {
  scan(workflow: CreationWorkflow): Promise<CreationWorkflow>;
}

export function createCreationObserver(
  config: GlobalConfig,
  client: Pick<ThruputClient, "getEvents">,
): CreationObserver {
  return {
    async scan(workflow) {
      if (
        workflow.status !== "queued"
        || workflow.requestId === null
        || workflow.enqueueReceiptBlock === null
        || workflow.pool === null
      ) return workflow;
      const requestBlock = BigInt(workflow.enqueueReceiptBlock);
      const anchorHeight = workflow.observedThroughBlock === null
        ? requestBlock
        : BigInt(workflow.observedThroughBlock) + 1n;
      let cursor: Uint8Array | undefined;
      let observedThrough = BigInt(
        workflow.observedThroughBlock ?? workflow.enqueueReceiptBlock,
      );
      let oldestRetained: bigint | null = null;
      let terminal: CreationWorkflow | null = null;
      const seenCursors = new Set<string>();
      const seenEvents = new Set<string>();

      for (;;) {
        const page: EventPage = await client.getEvents({
          filters: [
            MintEvent.filter({
              contractAddresses: [addressFromBase58(workflow.pool.handler)],
            }),
            RequestFailed.filter({
              contractAddresses: [addressFromBase58(workflow.pool.driver)],
            }),
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
          const key = `${toBase58(identified.txHash)}:${identified.sequenceNumber}`;
          if (seenEvents.has(key)) continue;
          seenEvents.add(key);
          const matched = matchTerminal(config, workflow, identified);
          if (matched === null) continue;
          if (terminal !== null) {
            throw new Error("Event history contains duplicate terminal creation events");
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
        throw new Error("Event history no longer covers this unresolved creation request");
      }
      return {
        ...workflow,
        observedThroughBlock: observedThrough.toString(),
        updatedAt: Date.now(),
      };
    },
  };
}

export function applyCreationReceipt(
  workflow: CreationWorkflow,
  receipt: TransactionReceipt,
): CreationWorkflow {
  if (workflow.status !== "queued" || workflow.requestId === null || workflow.pool === null) {
    return workflow;
  }
  const minted = MintEvent.allFromReceipt(receipt, {
    contractAddress: addressFromBase58(workflow.pool.handler),
  }).filter((event) => event.fields.request_id !== null
    && toHex0x(event.fields.request_id) === workflow.requestId
    && toBase58(event.topics.sender) === workflow.accountAddress
    && toBase58(event.topics.recipient) === workflow.accountAddress
    && event.fields.amount_minted > 0n);
  const failed = RequestFailed.allFromReceipt(receipt, {
    contractAddress: addressFromBase58(workflow.pool.driver),
  }).filter((event) => toHex0x(event.topics.request_id) === workflow.requestId);
  if (minted.length > 1 || failed.length > 1 || (minted.length > 0 && failed.length > 0)) {
    throw new Error("Queue receipt contains conflicting terminal creation events");
  }
  if (failed.length === 1) {
    return {
      ...workflow,
      status: "failed",
      terminalBlock: receipt.height.toString(),
      updatedAt: Date.now(),
    };
  }
  if (minted.length === 1) {
    return {
      ...workflow,
      status: "executed",
      terminalBlock: receipt.height.toString(),
      updatedAt: Date.now(),
    };
  }
  return workflow;
}

function matchTerminal(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  identified: IdentifiedEvent,
): CreationWorkflow | null {
  if (identified.blockHeight < BigInt(workflow.enqueueReceiptBlock!)) return null;
  const event = identified.event;
  if (bytesEqual(event.contractAddress, addressFromBase58(workflow.pool!.driver))) {
    const failed = RequestFailed.decode(event);
    if (failed === null || toHex0x(failed.topics.request_id) !== workflow.requestId) {
      return null;
    }
    return {
      ...workflow,
      status: "failed",
      terminalBlock: identified.blockHeight.toString(),
      updatedAt: Date.now(),
    };
  }
  if (!bytesEqual(event.contractAddress, addressFromBase58(workflow.pool!.handler))) {
    return null;
  }
  const minted = MintEvent.decode(event);
  if (
    minted === null
    || minted.fields.request_id === null
    || toHex0x(minted.fields.request_id) !== workflow.requestId
  ) return null;
  if (
    !bytesEqual(minted.topics.sender, config.accountAddress)
    || !bytesEqual(minted.topics.recipient, config.accountAddress)
    || minted.fields.amount_minted <= 0n
  ) throw new Error("Event history contains invalid terminal creation evidence");
  return {
    ...workflow,
    status: "executed",
    terminalBlock: identified.blockHeight.toString(),
    updatedAt: Date.now(),
  };
}
