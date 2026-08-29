import { describe, expect, test } from "vitest";
import {
  markChainReadFailed,
  reconcileChainMetadata,
  type ChainState,
} from "./metadata-state";

const metadata = {
  width: 10_000,
  height: 10_000,
  generation: "4",
  seed: "7",
  population: "12",
  stateDigest: `0x${"aa".repeat(32)}`,
  chunkBytes: 1_000,
  chunksPerRow: 2,
  maxQueueLength: 16,
} as const;
const state: ChainState = {
  chain: metadata,
  chainError: null,
  chainVerification: "fresh",
};

describe("chain metadata verification state", () => {
  test("treats lower and conflicting equal generations as integrity failures", () => {
    expect(
      reconcileChainMetadata(state, { ...metadata, generation: "3" }),
    ).toMatchObject({ chain: metadata, chainVerification: "integrity" });
    expect(
      reconcileChainMetadata(state, { ...metadata, population: "13" }),
    ).toMatchObject({ chain: metadata, chainVerification: "integrity" });
  });

  test("retains last verified metadata but marks transient failures stale", () => {
    expect(markChainReadFailed(state, "timed out")).toEqual({
      chain: metadata,
      chainError: "timed out",
      chainVerification: "stale",
    });
    expect(
      markChainReadFailed(
        { chain: null, chainError: null, chainVerification: "loading" },
        "offline",
      ).chainVerification,
    ).toBe("unavailable");
  });

  test("does not let a transient failure clear an integrity failure", () => {
    const integrity = reconcileChainMetadata(state, {
      ...metadata,
      generation: "3",
    });
    expect(markChainReadFailed(integrity, "offline")).toBe(integrity);
  });
});
