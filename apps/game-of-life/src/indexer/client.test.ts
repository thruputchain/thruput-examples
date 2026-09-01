import { describe, expect, test, vi } from "vitest";
import { IndexerClient } from "./client";
const network = "11".repeat(32),
  contract = `0x${"22".repeat(32)}`,
  digest = `0x${"aa".repeat(32)}`,
  block = `0x${"bb".repeat(32)}`;
const config = {
  indexerUrl: new URL("http://127.0.0.1:8787"),
  indexerProxyPath: "/groundhog-indexer/" as const,
  networkId: network,
  contractAddress: contract,
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
const provenance = {
  schemaVersion: 1,
  ...identity,
  sourceBlockHeight: "9",
  sourceBlockHash: block,
  evidenceKind: "metadata-observation",
  transactionHash: null,
  eventIndex: null,
  eventKind: null,
  requestId: null,
  requester: null,
  verifiedAt: "2026-08-28T01:02:03Z",
};
describe("immutable indexer client", () => {
  test("loads manifest and provenance concurrently from the confined digest directory", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const value = path.endsWith("latest.json")
        ? latest
        : path.endsWith("manifest.json")
          ? manifest
          : provenance;
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new IndexerClient(
      config,
      fetcher as typeof fetch,
      config.indexerUrl,
    );
    const snapshot = await client.snapshotFromPointer(await client.latest());
    expect(snapshot.manifest.stateDigest).toBe(digest);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(snapshot.manifestUrl.origin).toBe(config.indexerUrl.origin);
  });
  test("rejects non-JSON artifacts before parsing", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("{}", { headers: { "content-type": "text/plain" } }),
    );
    await expect(
      new IndexerClient(
        config,
        fetcher as typeof fetch,
        config.indexerUrl,
      ).latest(),
    ).rejects.toThrow(/content type/);
  });
  test("builds canonical immutable tile URLs", () => {
    const client = new IndexerClient(config);
    const snapshot = {
      latest,
      manifest,
      provenance,
      manifestUrl: new URL(latest.manifestUrl, config.indexerUrl),
    } as never;
    expect(client.tileUrl(snapshot, 6, 39, 39).pathname).toMatch(
      /tiles\/6\/39\/39\.bin$/,
    );
    expect(() => client.tileUrl(snapshot, 7, 0, 0)).toThrow(RangeError);
    expect(() => client.tileUrl(snapshot, 6, 40, 0)).toThrow(RangeError);
  });
});
