import { describe, expect, test } from "vitest";
import type { ChainMetadata } from "@/chain/game-of-life";
import type { ImmutableSnapshot } from "@/indexer/client";
import {
  INITIAL_EVIDENCE_STATE,
  evidenceReducer,
  reconcileEvidence,
  type XrayEvidenceState,
} from "./evidence";

const scope = {
  networkId: "aa".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
};
const digest = `0x${"dd".repeat(32)}`;
const blockHash = `0x${"bb".repeat(32)}`;
const chain: ChainMetadata = {
  width: 10_000,
  height: 10_000,
  generation: "1",
  seed: "7",
  population: "32769",
  stateDigest: digest,
  chunkBytes: 1_000,
  chunksPerRow: 2,
  maxQueueLength: 16,
};

function snapshot(
  generation = "1",
  evidenceKind:
    | "metadata-observation"
    | "generation-advanced-event" = "generation-advanced-event",
): ImmutableSnapshot {
  const stateDigest = generation === "1" ? digest : `0x${"aa".repeat(32)}`;
  const population = generation === "1" ? "32769" : "32768";
  const identity = {
    ...scope,
    generation,
    seed: "7",
    population,
    stateDigest,
  };
  const eventBacked = evidenceKind === "generation-advanced-event";
  return {
    latest: {
      schemaVersion: 1,
      generation,
      stateDigest,
      manifestUrl: `/v1/worlds/${scope.networkId}/${scope.contractAddress}/${stateDigest}/manifest.json`,
      sourceBlockHeight: generation,
      sourceBlockHash: blockHash,
      publishedAt: "2026-08-28T01:02:03Z",
    },
    manifest: {
      schemaVersion: 1,
      ...identity,
      width: 10_000,
      height: 10_000,
      tileSize: 256,
      maxZoom: 6,
      densityEncoding: "u16le-live-count",
      cellEncoding: "row-major-lsb-first",
      tilePathTemplate: "tiles/{z}/{x}/{y}.bin",
      verification: {
        canonicalDownloadVerified: true,
        individualTileProofs: false,
      },
    },
    provenance: {
      schemaVersion: 1,
      ...identity,
      sourceBlockHeight: generation,
      sourceBlockHash: blockHash,
      evidenceKind,
      transactionHash: eventBacked ? `0x${"cc".repeat(32)}` : null,
      eventIndex: eventBacked ? 1 : null,
      eventKind: eventBacked ? "GenerationAdvanced" : null,
      requestId: eventBacked ? `0x${"ef".repeat(32)}` : null,
      requester: eventBacked ? scope.contractAddress : null,
      verifiedAt: "2026-08-28T01:02:03Z",
    },
    manifestUrl: new URL("http://127.0.0.1/manifest.json"),
  };
}

function readyState(value: ImmutableSnapshot): XrayEvidenceState {
  return evidenceReducer(
    evidenceReducer(INITIAL_EVIDENCE_STATE, {
      type: "chain-read",
      value: chain,
    }),
    { type: "snapshot-read", value },
  );
}

describe("X-Ray evidence reconciliation", () => {
  test("distinguishes no evidence, chain-only, and retained snapshot states", () => {
    const noEvidence = evidenceReducer(
      evidenceReducer(INITIAL_EVIDENCE_STATE, {
        type: "chain-failed",
        condition: "unavailable",
        error: "RPC unavailable",
      }),
      {
        type: "snapshot-failed",
        condition: "unavailable",
        error: "Indexer unavailable",
      },
    );
    expect(reconcileEvidence(noEvidence, scope).relationship).toBe(
      "no-live-evidence",
    );
    const chainOnly = evidenceReducer(noEvidence, {
      type: "chain-read",
      value: chain,
    });
    expect(reconcileEvidence(chainOnly, scope).relationship).toBe("chain-only");
    const retained = evidenceReducer(noEvidence, {
      type: "snapshot-read",
      value: snapshot(),
    });
    expect(reconcileEvidence(retained, scope).relationship).toBe(
      "snapshot-retained",
    );
  });

  test("aligns matching independently loaded identities", () => {
    expect(reconcileEvidence(readyState(snapshot()), scope)).toMatchObject({
      relationship: "aligned",
      label: "Chain and snapshot aligned",
    });
  });

  test("keeps an older event-backed snapshot as eligible evidence", () => {
    expect(reconcileEvidence(readyState(snapshot("0")), scope)).toMatchObject({
      relationship: "indexer-behind",
      label: "Indexer behind",
    });
  });

  test("rejects an older metadata observation as an integrity conflict", () => {
    expect(
      reconcileEvidence(
        readyState(snapshot("0", "metadata-observation")),
        scope,
      ),
    ).toMatchObject({
      relationship: "integrity-conflict",
      detail: "metadata observation does not describe current chain state",
    });
  });

  test("preserves stale values without presenting them as current", () => {
    const state = evidenceReducer(readyState(snapshot()), {
      type: "chain-failed",
      condition: "unavailable",
      error: "RPC unavailable",
    });
    expect(state.chain.value).toEqual(chain);
    expect(state.chain.status).toBe("stale");
    expect(reconcileEvidence(state, scope)).toMatchObject({
      relationship: "aligned",
      label: "Last observed: Chain and snapshot aligned",
      stale: true,
    });
  });

  test("preserves a snapshot after an unavailable refresh", () => {
    const state = evidenceReducer(readyState(snapshot()), {
      type: "snapshot-failed",
      condition: "unavailable",
      error: "Indexer request failed (503)",
    });
    expect(state.snapshot.value).not.toBeNull();
    expect(state.snapshot.failure).toBe("unavailable");
    expect(reconcileEvidence(state, scope)).toMatchObject({
      relationship: "aligned",
      label: "Last observed: Chain and snapshot aligned",
    });
  });

  test("gives a malformed refresh precedence while retaining prior evidence", () => {
    let state = evidenceReducer(readyState(snapshot()), {
      type: "chain-read",
      value: { ...chain, generation: "0" },
    });
    state = evidenceReducer(state, {
      type: "snapshot-failed",
      condition: "malformed",
      error: "latest and manifest stateDigest disagree",
    });
    expect(state.snapshot.value).not.toBeNull();
    expect(reconcileEvidence(state, scope)).toMatchObject({
      relationship: "incompatible",
      label: "Retained snapshot; incompatible refresh",
    });
  });

  test("keeps malformed snapshots distinct from source unavailability", () => {
    const malformed = evidenceReducer(INITIAL_EVIDENCE_STATE, {
      type: "snapshot-failed",
      condition: "malformed",
      error: "latest and manifest stateDigest disagree",
    });
    expect(reconcileEvidence(malformed, scope)).toMatchObject({
      relationship: "incompatible",
      label: "Incompatible snapshot",
    });
    const unavailable = evidenceReducer(INITIAL_EVIDENCE_STATE, {
      type: "snapshot-failed",
      condition: "unavailable",
      error: "Indexer request failed (503)",
    });
    expect(reconcileEvidence(unavailable, scope).relationship).toBe(
      "no-live-evidence",
    );
  });

  test("retains accepted chain metadata after a regression", () => {
    const state = evidenceReducer(
      evidenceReducer(INITIAL_EVIDENCE_STATE, {
        type: "chain-read",
        value: chain,
      }),
      {
        type: "chain-read",
        value: { ...chain, generation: "0" },
      },
    );
    expect(state.chain.value).toEqual(chain);
    expect(reconcileEvidence(state, scope).relationship).toBe(
      "integrity-conflict",
    );
  });

  test("rejects snapshots ahead of chain or with conflicting identities", () => {
    expect(
      reconcileEvidence(readyState(snapshot("2")), scope).relationship,
    ).toBe("integrity-conflict");

    const seedConflict = snapshot();
    const conflictingSeed = {
      ...seedConflict,
      manifest: { ...seedConflict.manifest, seed: "8" },
      provenance: { ...seedConflict.provenance, seed: "8" },
    };
    expect(
      reconcileEvidence(readyState(conflictingSeed), scope).relationship,
    ).toBe("integrity-conflict");

    const digestConflict = snapshot();
    const otherDigest = `0x${"ee".repeat(32)}`;
    const conflictingDigest = {
      ...digestConflict,
      manifest: { ...digestConflict.manifest, stateDigest: otherDigest },
      provenance: { ...digestConflict.provenance, stateDigest: otherDigest },
    };
    expect(
      reconcileEvidence(readyState(conflictingDigest), scope).relationship,
    ).toBe("integrity-conflict");
  });

  test("accepts world initialization as event-backed historical evidence", () => {
    const initialized = snapshot("0");
    const worldInitialized = {
      ...initialized,
      provenance: {
        ...initialized.provenance,
        evidenceKind: "world-initialized-event" as const,
        eventKind: "WorldInitialized" as const,
        requestId: null,
        requester: null,
      },
    };
    expect(
      reconcileEvidence(readyState(worldInitialized), scope).relationship,
    ).toBe("indexer-behind");
  });
});
