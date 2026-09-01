import { describe, expect, test } from "vitest";
import {
  assertSnapshotAgreement,
  assertSnapshotEligible,
  parseLatest,
  parseManifest,
  parseProvenance,
  parseStatus,
} from "./schema";
const network = "11".repeat(32);
const contract = `0x${"22".repeat(32)}`;
const digest = `0x${"aa".repeat(32)}`;
const block = `0x${"bb".repeat(32)}`;
const identity = {
  networkId: network,
  contractAddress: contract,
  generation: "0",
  seed: "7",
  population: "1",
  stateDigest: digest,
};
const manifest = {
  schemaVersion: 1,
  ...identity,
  width: 10000,
  height: 10000,
  tileSize: 256,
  maxZoom: 6,
  densityEncoding: "u16le-live-count",
  cellEncoding: "row-major-lsb-first",
  tilePathTemplate: "tiles/{z}/{x}/{y}.bin",
  verification: {
    canonicalDownloadVerified: true,
    individualTileProofs: false,
  },
};
const latest = {
  schemaVersion: 1,
  generation: "0",
  stateDigest: digest,
  manifestUrl: `/v1/worlds/${network}/${contract}/${digest}/manifest.json`,
  sourceBlockHeight: "9",
  sourceBlockHash: block,
  publishedAt: "2026-08-28T01:02:03Z",
};
const provenance = {
  schemaVersion: 1,
  ...identity,
  sourceBlockHeight: "9",
  sourceBlockHash: block,
  evidenceKind: "world-initialized-event",
  transactionHash: `0x${"cc".repeat(32)}`,
  eventIndex: 0,
  eventKind: "WorldInitialized",
  requestId: null,
  requester: null,
  verifiedAt: "2026-08-28T01:02:03.456Z",
};
describe("artifact schemas", () => {
  test("accepts one agreeing immutable snapshot", () => {
    const l = parseLatest(latest, network, contract);
    const m = parseManifest(manifest);
    const p = parseProvenance(provenance);
    expect(() => assertSnapshotAgreement(l, m, p)).not.toThrow();
  });
  test.each(["generation", "seed", "population"])(
    "rejects noncanonical %s decimals",
    (field) =>
      expect(() => parseManifest({ ...manifest, [field]: "01" })).toThrow(
        /canonical u64/,
      ),
  );
  test("rejects unknown fields recursively", () => {
    expect(() => parseManifest({ ...manifest, extra: true })).toThrow(
      /unknown/,
    );
    expect(() =>
      parseManifest({
        ...manifest,
        verification: { ...manifest.verification, extra: true },
      }),
    ).toThrow(/unknown/);
  });
  test("rejects escaping or cross-scope latest URLs", () =>
    expect(() =>
      parseLatest(
        { ...latest, manifestUrl: `${digest}/manifest.json` },
        network,
        contract,
      ),
    ).toThrow(/manifestUrl/));
  test("rejects impossible calendar dates", () =>
    expect(() =>
      parseLatest(
        { ...latest, publishedAt: "2026-02-30T01:02:03Z" },
        network,
        contract,
      ),
    ).toThrow(/date/));
  test("enforces initialization provenance fields", () => {
    expect(() => parseProvenance({ ...provenance, generation: "1" })).toThrow(
      /disagree/,
    );
    expect(() => parseProvenance({ ...provenance, requestId: digest })).toThrow(
      /disagree/,
    );
  });
  test("enforces advanced provenance fields", () => {
    const advanced = {
      ...provenance,
      generation: "1",
      evidenceKind: "generation-advanced-event",
      eventKind: "GenerationAdvanced",
      requestId: digest,
      requester: contract,
    };
    expect(parseProvenance(advanced).eventKind).toBe("GenerationAdvanced");
    expect(() => parseProvenance({ ...advanced, requester: null })).toThrow(
      /disagree/,
    );
  });
  test("enforces status state cross-fields", () => {
    const status = {
      schemaVersion: 1,
      state: "preparing",
      observed: null,
      preparing: {
        generation: "1",
        stateDigest: digest,
        completedUnits: 2,
        totalUnits: 3,
        unit: "tiles",
      },
      published: null,
      retry: null,
      errorCode: null,
      heartbeatAt: "2026-08-28T01:02:03Z",
    };
    expect(parseStatus(status).preparing?.completedUnits).toBe(2);
    expect(() => parseStatus({ ...status, state: "idle" })).toThrow(
      /match state/,
    );
    expect(() =>
      parseStatus({
        ...status,
        preparing: { ...status.preparing, completedUnits: 4 },
      }),
    ).toThrow(/exceeds/);
  });
  test("detects cross-document disagreement", () => {
    const l = parseLatest(latest, network, contract);
    const m = parseManifest(manifest);
    const p = parseProvenance({ ...provenance, population: "2" });
    expect(() => assertSnapshotAgreement(l, m, p)).toThrow(/population/);
  });
  test("requires exact current chain metadata and configured scope", () => {
    const m = parseManifest(manifest);
    const p = parseProvenance(provenance);
    const current = {
      width: 10000,
      height: 10000,
      generation: "0",
      seed: "7",
      population: "1",
      stateDigest: digest,
    };
    expect(() =>
      assertSnapshotEligible(m, p, current, {
        networkId: network,
        contractAddress: contract,
      }),
    ).not.toThrow();
    expect(() =>
      assertSnapshotEligible(
        m,
        p,
        { ...current, seed: "8" },
        {
          networkId: network,
          contractAddress: contract,
        },
      ),
    ).toThrow(/seed/);
    expect(() =>
      assertSnapshotEligible(m, p, current, {
        networkId: "33".repeat(32),
        contractAddress: contract,
      }),
    ).toThrow(/scope/);
  });
  test("accepts historical event evidence but not historical metadata evidence", () => {
    const current = {
      width: 10000,
      height: 10000,
      generation: "1",
      seed: "7",
      population: "2",
      stateDigest: `0x${"dd".repeat(32)}`,
    };
    expect(() =>
      assertSnapshotEligible(
        parseManifest(manifest),
        parseProvenance(provenance),
        current,
        { networkId: network, contractAddress: contract },
      ),
    ).not.toThrow();
    const metadata = {
      ...provenance,
      evidenceKind: "metadata-observation",
      transactionHash: null,
      eventIndex: null,
      eventKind: null,
    };
    expect(() =>
      assertSnapshotEligible(
        parseManifest(manifest),
        parseProvenance(metadata),
        current,
        { networkId: network, contractAddress: contract },
      ),
    ).toThrow(/current chain state/);
  });
  test("rejects event-backed candidates ahead of accepted chain metadata", () => {
    const advanced = parseProvenance({
      ...provenance,
      generation: "1",
      evidenceKind: "generation-advanced-event",
      eventKind: "GenerationAdvanced",
      requestId: digest,
      requester: contract,
    });
    const aheadManifest = parseManifest({ ...manifest, generation: "1" });
    expect(() =>
      assertSnapshotEligible(
        aheadManifest,
        advanced,
        {
          width: 10000,
          height: 10000,
          generation: "0",
          seed: "7",
          population: "1",
          stateDigest: digest,
        },
        { networkId: network, contractAddress: contract },
      ),
    ).toThrow(/ahead/);
  });

  test("requires exact identity at the accepted current generation", () => {
    expect(() =>
      assertSnapshotEligible(
        parseManifest(manifest),
        parseProvenance(provenance),
        {
          width: 10000,
          height: 10000,
          generation: "0",
          seed: "7",
          population: "2",
          stateDigest: digest,
        },
        { networkId: network, contractAddress: contract },
      ),
    ).toThrow(/population/);
  });
});
