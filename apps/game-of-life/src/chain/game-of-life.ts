import type {
  ContractView,
  EventPage,
  GroundhogClient,
} from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";
import {
  GameOfLife,
  GenerationAdvanced,
  TickRequested,
  WorldInitialized,
  decodeEvent,
  type GameOfLifeEvent,
} from "@/contracts/generated/game-of-life";

export interface ChainMetadata {
  readonly width: 10_000;
  readonly height: 10_000;
  readonly generation: string;
  readonly seed: string;
  readonly population: string;
  readonly stateDigest: string;
  readonly chunkBytes: 1_000;
  readonly chunksPerRow: 2;
  readonly maxQueueLength: number;
}

export type LifeChainEvent =
  | {
      readonly kind: "WorldInitialized";
      readonly blockHeight: string;
      readonly transactionHash: string;
      readonly sequenceNumber: number;
      readonly seed: string;
      readonly maxQueueLength: number;
      readonly population: string;
      readonly stateDigest: string;
    }
  | {
      readonly kind: "TickRequested";
      readonly blockHeight: string;
      readonly transactionHash: string;
      readonly sequenceNumber: number;
      readonly requestId: string;
      readonly requester: string;
    }
  | {
      readonly kind: "GenerationAdvanced";
      readonly blockHeight: string;
      readonly transactionHash: string;
      readonly sequenceNumber: number;
      readonly requestId: string;
      readonly requester: string;
      readonly generation: string;
      readonly population: string;
      readonly stateDigest: string;
    };

export interface LifeReadAdapter {
  metadata(): Promise<ContractView<ChainMetadata>>;
  events(fromBlock: bigint): Promise<readonly LifeChainEvent[]>;
  decodeEvent(event: {
    topics: Uint8Array[];
    data: Uint8Array;
  }): GameOfLifeEvent | null;
}

export function createLifeReadAdapter(params: {
  readonly client: Pick<GroundhogClient, "view" | "getEvents">;
  readonly contractAddress: string;
}): LifeReadAdapter {
  const contract = contractAddressFromHex(params.contractAddress);
  return {
    async metadata() {
      const result = await GameOfLife.getMetadata.view({
        client: params.client,
        contract,
      });
      const value = result.value;
      if (
        value.width !== 10_000n ||
        value.height !== 10_000n ||
        value.chunk_bytes !== 1_000n ||
        value.chunks_per_row !== 2n ||
        value.population > 100_000_000n ||
        value.max_queue_len <= 0n ||
        value.max_queue_len > 0xffff_ffffn
      ) {
        throw new Error("Contract returned an unsupported world schema");
      }
      return {
        ...result,
        value: {
          width: 10_000,
          height: 10_000,
          generation: value.generation.toString(),
          seed: value.seed.toString(),
          population: value.population.toString(),
          stateDigest: hex(value.state_digest),
          chunkBytes: 1_000,
          chunksPerRow: 2,
          maxQueueLength: Number(value.max_queue_len),
        },
      };
    },
    async events(fromBlock) {
      if (fromBlock < 0n)
        throw new RangeError("event anchor must be nonnegative");
      const output: LifeChainEvent[] = [];
      const seenEvents = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: Uint8Array | undefined;
      for (;;) {
        const page: EventPage = await params.client.getEvents({
          filters: [
            WorldInitialized.filter({ contractAddresses: [contract] }),
            TickRequested.filter({ contractAddresses: [contract] }),
            GenerationAdvanced.filter({ contractAddresses: [contract] }),
          ],
          order: "ascending",
          anchor: { height: fromBlock },
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const identified of page.events) {
          if (!sameAddress(identified.event.contractAddress, contract))
            continue;
          const key = `${hex(identified.txHash)}:${identified.sequenceNumber}`;
          if (seenEvents.has(key)) continue;
          seenEvents.add(key);
          const event = decodeEvent(identified.event);
          if (!event) continue;
          const common = {
            blockHeight: identified.blockHeight.toString(),
            transactionHash: hex(identified.txHash),
            sequenceNumber: identified.sequenceNumber,
          };
          if (event.name === "WorldInitialized") {
            if (
              event.fields.max_queue_len <= 0n ||
              event.fields.max_queue_len > 0xffff_ffffn ||
              event.fields.population > 100_000_000n
            )
              throw new Error("Invalid WorldInitialized event");
            output.push({
              kind: "WorldInitialized",
              ...common,
              seed: event.fields.seed.toString(),
              maxQueueLength: Number(event.fields.max_queue_len),
              population: event.fields.population.toString(),
              stateDigest: hex(event.fields.state_digest),
            });
          } else if (event.name === "TickRequested") {
            output.push({
              kind: "TickRequested",
              ...common,
              requestId: hex(event.topics.request_id),
              requester: hex(event.topics.requested_by),
            });
          } else {
            if (
              event.fields.generation === 0n ||
              event.fields.population > 100_000_000n
            )
              throw new Error("Invalid GenerationAdvanced event");
            output.push({
              kind: "GenerationAdvanced",
              ...common,
              requestId: hex(event.topics.request_id),
              requester: hex(event.fields.requested_by),
              generation: event.fields.generation.toString(),
              population: event.fields.population.toString(),
              stateDigest: hex(event.fields.state_digest),
            });
          }
        }
        if (page.cursor.length === 0) break;
        const cursorKey = hex(page.cursor);
        if (seenCursors.has(cursorKey))
          throw new Error("Event query returned a repeated cursor");
        seenCursors.add(cursorKey);
        cursor = page.cursor;
      }
      return output;
    },
    decodeEvent,
  };
}

export function sameAddress(
  left: ContractAddress,
  right: ContractAddress,
): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function hex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function contractAddressFromHex(value: string): ContractAddress {
  if (!/^0x[0-9a-f]{64}$/.test(value))
    throw new Error("Contract address must be canonical lowercase hex32");
  return Uint8Array.from(
    value
      .slice(2)
      .match(/../g)!
      .map((byte) => Number.parseInt(byte, 16)),
  ) as ContractAddress;
}
