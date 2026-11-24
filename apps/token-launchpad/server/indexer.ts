import {
  addressFromBase58,
  createThruputClient,
  defineCluster,
  hashFromBase58,
  HistoryWalkError,
  HttpTransport,
  toBase58,
  type CoreThruputClient,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import { standard_token_factory_if } from "../src/contracts/generated/standard-token-factory.ts";
import type { TokenStore } from "./store.ts";

const TokenCreated = standard_token_factory_if.v0_1.events.TokenCreated;

export interface IndexerStatus {
  /** The last block height whose events are all saved. */
  indexedThrough: string | null;
  /**
   * The event walk failed a history check, for example because the node no
   * longer serves events the index needs.
   */
  historyError: boolean;
  lastError: string | null;
}

export async function createIndexerClient(config: {
  rpcUrl: string;
  networkId: string;
}) {
  return createThruputClient({
    cluster: defineCluster({
      name: "launchpad-indexer",
      rpcUrl: config.rpcUrl,
      // The client checks that the node belongs to this network.
      networkHash: networkHash(hashFromBase58(config.networkId)),
      capabilities: [] as const,
    }),
    transport: new HttpTransport(config.rpcUrl, { timeoutMs: 10_000 }),
  });
}

/**
 * Index the factory's `TokenCreated` events into the store.
 *
 * Each pass walks the events from the saved checkpoint up to the node's
 * latest indexed block, saves every event by its identity
 * (transaction hash and sequence number), then saves the new checkpoint. The
 * next pass starts at that block again, so a replayed block is harmless.
 *
 * The RPC node serves events only for a retention window. This index keeps
 * them for as long as the app needs them.
 */
export async function indexOnce(
  client: CoreThruputClient,
  store: TokenStore,
  factory: string,
): Promise<bigint | undefined> {
  const saved = store.loadCheckpoint();
  const pages = client.iterateEventPages({
    filters: [TokenCreated.filter({ addresses: [addressFromBase58(factory)] })],
    start: {
      order: "ascending",
      anchor:
        saved === undefined
          ? { kind: "atBeginning" }
          : { kind: "atHeight", blockHeight: saved },
    },
    limit: 200,
  });
  for (;;) {
    const step = await pages.next();
    if (step.done) {
      const done = step.value.completedThroughBlockHeight;
      if (done !== undefined) store.saveCheckpoint(done);
      return done;
    }
    for (const row of step.value.events) {
      const event = TokenCreated.decode(row.event);
      if (!event) continue;
      store.saveToken(
        {
          address: toBase58(event.topics.token),
          creator: toBase58(event.topics.creator),
          name: event.fields.name,
          symbol: event.fields.symbol,
          decimals:
            event.fields.decimals === null
              ? null
              : Number(event.fields.decimals),
          initialSupply: event.fields.initial_supply.toString(),
          blockHeight: row.blockHeight.toString(),
          transactionHash: toBase58(row.transactionHash),
        },
        Number(row.sequenceNumber),
      );
    }
  }
}

/** Run `indexOnce` every few seconds until `stop` is called. */
export function startIndexer(
  client: CoreThruputClient,
  store: TokenStore,
  factory: string,
  intervalMs = 3_000,
) {
  const status: IndexerStatus = {
    indexedThrough: null,
    historyError: false,
    lastError: null,
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      const done = await indexOnce(client, store, factory);
      if (done !== undefined) status.indexedThrough = done.toString();
      // A pass walks from the checkpoint, so success means there is no gap.
      status.historyError = false;
      status.lastError = null;
    } catch (error) {
      status.historyError = error instanceof HistoryWalkError;
      status.lastError = error instanceof Error ? error.message : String(error);
      console.error(`Token indexer: ${status.lastError}`);
    }
    if (!stopped) timer = setTimeout(run, intervalMs);
  };
  void run();
  return {
    status,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
