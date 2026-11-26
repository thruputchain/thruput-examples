// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ThruputError,
  toBase58,
  type CoreThruputClient,
} from "@thruputchain/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startIndexer } from "./indexer";
import { TokenStore } from "./store";

let directory: string;
let store: TokenStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "launchpad-indexer-"));
  store = new TokenStore(join(directory, "tokens.sqlite"), {
    networkId: "network",
    factoryAddress: toBase58(new Uint8Array(32)),
  });
});
afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true });
});

it("clears the history error after a later pass succeeds", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let pass = 0;
  const client = {
    async *iterateEventPages() {
      pass += 1;
      if (pass === 1)
        throw new ThruputError("historyWalkFailed", "History retention no longer covers the requested range", { context: { page: {} as never } });
      return { completedThroughBlockHeight: 5n };
    },
  } as unknown as CoreThruputClient;
  const indexer = startIndexer(client, store, toBase58(new Uint8Array(32)), 300);
  try {
    await vi.waitFor(() => expect(indexer.status.historyError).toBe(true), { interval: 5 });
    await vi.waitFor(() => expect(indexer.status.indexedThrough).toBe("5"));
    expect(indexer.status.historyError).toBe(false);
    expect(indexer.status.lastError).toBeNull();
  } finally {
    indexer.stop();
  }
});
