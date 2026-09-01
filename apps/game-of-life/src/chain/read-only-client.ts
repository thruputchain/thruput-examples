import type {
  EmittedEvent,
  EventPage,
  EventQuery,
  GroundhogClient,
  IdentifiedEvent,
  ViewRequest,
  ViewResponse,
} from "@groundhogchain/client";
import { HttpTransport } from "@groundhogchain/client/transport";
import type { ContractAddress, SHA256Hash } from "@groundhogchain/protocol";
import type { ReadAppConfig } from "@/config";

export type ReadOnlyClient = Pick<GroundhogClient, "view" | "getEvents">;

export class MalformedRpcResponseError extends Error {
  override readonly name = "MalformedRpcResponseError";
}

export function createReadOnlyClient(
  config: Pick<ReadAppConfig, "rpcUrl" | "rpcProxyPath">,
): ReadOnlyClient {
  const browser = typeof window === "undefined" ? undefined : window.location;
  const url = browser
    ? new URL(config.rpcProxyPath, browser.origin).href
    : config.rpcUrl.href;
  const transport = new HttpTransport(url, {
    fetch: (...args) => globalThis.fetch(...args),
    timeoutMs: 10_000,
  });
  return {
    view: async (request) =>
      parseView(
        await rpcRequest(transport, "groundhog_view", [serializeView(request)]),
      ),
    getEvents: async (query) =>
      parseEvents(
        await rpcRequest(transport, "groundhog_getEvents", [
          serializeEventQuery(query),
        ]),
      ),
  };
}

async function rpcRequest(
  transport: HttpTransport,
  method: string,
  params: unknown[],
): Promise<unknown> {
  try {
    return await transport.request(method, params);
  } catch (cause) {
    if (
      cause instanceof SyntaxError ||
      (cause instanceof Error &&
        /^Invalid JSON-RPC .*response$/.test(cause.message))
    )
      throw new MalformedRpcResponseError(
        cause instanceof Error ? cause.message : "Invalid JSON-RPC response",
        { cause },
      );
    throw cause;
  }
}

function serializeView(request: ViewRequest) {
  if (request.entrypoint.length !== 8)
    throw new Error(
      `view: entrypoint must be exactly 8 bytes, got ${request.entrypoint.length}`,
    );
  return {
    contract: hex(request.contract),
    entrypoint: hex(request.entrypoint),
    calldata: hex(request.calldata),
    ...(request.caller ? { caller: hex(request.caller) } : {}),
  };
}

function parseView(value: unknown): ViewResponse {
  const response = record(value, "view response");
  if (!Array.isArray(response.events))
    malformed("Expected view response events to be an array");
  return {
    output: parseViewOutput(response.output),
    events: response.events.map(parseEmittedEvent),
    height: BigInt(decimal(response.height, "view height")),
  };
}

function parseViewOutput(value: unknown): ViewResponse["output"] {
  const output = record(value, "view output");
  switch (output.result) {
    case "return":
      return {
        result: "return",
        returnData: bytes(output.returnData, "returnData"),
      };
    case "abort":
      return {
        result: "abort",
        abortData: bytes(output.abortData, "abortData"),
      };
    case "fault":
      return { result: "fault" };
    default:
      return malformed(`Unknown view output result: ${String(output.result)}`);
  }
}

function serializeEventQuery(query: EventQuery) {
  const anchor =
    query.anchor === "beginning"
      ? { kind: "atBeginning" }
      : query.anchor === "end"
        ? { kind: "atEnd" }
        : query.anchor
          ? { kind: "atHeight", height: Number(query.anchor.height) }
          : { kind: "atBeginning" };
  return {
    filters: query.filters.map((filter) => ({
      contractAddresses: filter.contractAddresses.map(hex),
      topics: {
        topic0: (filter.topics?.topic0 ?? []).map(hex),
        topic1: (filter.topics?.topic1 ?? []).map(hex),
        topic2: (filter.topics?.topic2 ?? []).map(hex),
      },
    })),
    order: query.order ?? "ascending",
    anchor,
    cursor: query.cursor ? hex(query.cursor) : "0x",
    limit: query.limit ?? 50,
  };
}

function parseEvents(value: unknown): EventPage {
  const page = record(value, "events response");
  if (!Array.isArray(page.events))
    malformed("Invalid events response: expected events");
  return {
    events: page.events.map(parseIdentifiedEvent),
    cursor: bytes(page.cursor, "cursor"),
    latestBlock: BigInt(decimal(page.latestBlock, "latestBlock")),
    oldestBlock: BigInt(decimal(page.oldestBlock, "oldestBlock")),
  };
}

function parseIdentifiedEvent(value: unknown): IdentifiedEvent {
  const entry = record(value, "event entry");
  if (typeof entry.sequenceNumber !== "number")
    malformed("Invalid events response: expected sequenceNumber");
  const txHash = bytes(entry.txHash, "txHash");
  if (txHash.length !== 32)
    malformed("Invalid events response: txHash must be 32 bytes");
  return {
    txHash: txHash as SHA256Hash,
    blockHeight: BigInt(decimal(entry.blockHeight, "blockHeight")),
    sequenceNumber: entry.sequenceNumber,
    event: parseEmittedEvent(entry.event),
  };
}

function parseEmittedEvent(value: unknown): EmittedEvent {
  const event = record(value, "emitted event");
  const contractAddress = bytes(event.contractAddress, "contractAddress");
  if (contractAddress.length !== 32)
    malformed("Invalid emitted event: contractAddress must be 32 bytes");
  if (!Array.isArray(event.topics))
    malformed("Invalid emitted event: expected topics");
  if (event.topics.length > 3)
    malformed("Invalid emitted event: expected at most 3 topics");
  const topics = event.topics.map((topic, index) => {
    const result = bytes(topic, `topic ${index}`);
    if (result.length !== 32)
      malformed(`Invalid emitted event: topic ${index} must be 32 bytes`);
    return result;
  });
  const data = bytes(event.data, "event data");
  if (topics.length * 32 + data.length > 1_024)
    malformed("Invalid emitted event: serialized event exceeds 1024 bytes");
  return {
    contractAddress: contractAddress as ContractAddress,
    topics,
    data,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    malformed(`Invalid ${label}: expected an object`);
  return value as Record<string, unknown>;
}

function decimal(value: unknown, label: string): string | number {
  if (!(
    (typeof value === "string" && /^\d+$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  ))
    malformed(`Invalid ${label}: expected a non-negative decimal integer`);
  return value;
}

function bytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
    malformed(`Invalid ${label}: expected 0x-prefixed byte hex`);
  return Uint8Array.from(
    value
      .slice(2)
      .match(/../g)
      ?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function hex(value: Uint8Array): string {
  return `0x${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function malformed(message: string): never {
  throw new MalformedRpcResponseError(message);
}
