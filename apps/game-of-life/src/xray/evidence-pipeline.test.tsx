import { render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ReadAppConfig } from "@/config";
import type { ImmutableSnapshot } from "@/indexer/client";
import { ComparisonFramework } from "./comparison-framework";
import { EvidencePipeline } from "./evidence-pipeline";
import {
  INITIAL_EVIDENCE_STATE,
  evidenceReducer,
  reconcileEvidence,
} from "./evidence";

const config = {
  rpcUrl: new URL("http://127.0.0.1:9545"),
  rpcProxyPath: "/groundhog-rpc",
  networkId: "aa".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
  indexerUrl: new URL("http://127.0.0.1:8787"),
  indexerProxyPath: "/groundhog-indexer/",
} satisfies ReadAppConfig;
const digest = `0x${"dd".repeat(32)}`;
const blockHash = `0x${"bb".repeat(32)}`;

const snapshot: ImmutableSnapshot = {
  latest: {
    schemaVersion: 1,
    generation: "1",
    stateDigest: digest,
    manifestUrl: `/v1/worlds/${config.networkId}/${config.contractAddress}/${digest}/manifest.json`,
    sourceBlockHeight: "10",
    sourceBlockHash: blockHash,
    publishedAt: "2026-08-28T01:02:03Z",
  },
  manifest: {
    schemaVersion: 1,
    networkId: config.networkId,
    contractAddress: config.contractAddress,
    generation: "1",
    seed: "7",
    population: "32769",
    stateDigest: digest,
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
    networkId: config.networkId,
    contractAddress: config.contractAddress,
    generation: "1",
    seed: "7",
    population: "32769",
    stateDigest: digest,
    sourceBlockHeight: "10",
    sourceBlockHash: blockHash,
    evidenceKind: "metadata-observation",
    transactionHash: null,
    eventIndex: null,
    eventKind: null,
    requestId: null,
    requester: null,
    verifiedAt: "2026-08-28T01:02:03Z",
  },
  manifestUrl: new URL("http://127.0.0.1/manifest.json"),
};

const state = evidenceReducer(
  evidenceReducer(INITIAL_EVIDENCE_STATE, {
    type: "chain-read",
    value: {
      width: 10_000,
      height: 10_000,
      generation: "1",
      seed: "7",
      population: "32769",
      stateDigest: digest,
      chunkBytes: 1_000,
      chunksPerRow: 2,
      maxQueueLength: 16,
    },
  }),
  { type: "snapshot-read", value: snapshot },
);

describe("X-Ray evidence presentation", () => {
  test("shows aligned source identities without inventing event fields", () => {
    render(
      <EvidencePipeline
        config={config}
        state={state}
        relationship={reconcileEvidence(state, config)}
        onRetry={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/RELATIONSHIP \/ Chain and snapshot aligned/),
    ).toBeInTheDocument();
    expect(screen.getByText("metadata-observation")).toBeInTheDocument();
    expect(
      screen.getAllByText("Not present / metadata-observation"),
    ).toHaveLength(2);
    expect(screen.getByText(/Active B · Inactive A/)).toBeInTheDocument();
    expect(
      screen.getByText(/Contract-derived from generation parity/),
    ).toBeInTheDocument();
  });

  test("states each proof boundary and the absence of tile proofs", () => {
    render(
      <EvidencePipeline
        config={config}
        state={state}
        relationship={reconcileEvidence(state, config)}
        onRetry={vi.fn()}
      />,
    );
    const pipeline = within(
      screen.getByRole("list", { name: "Proof pipeline" }),
    );
    expect(pipeline.getAllByRole("listitem")).toHaveLength(12);
    for (const heading of ["Chain", "Indexer", "Browser"])
      expect(
        screen.getByRole("heading", { name: heading }),
      ).toBeInTheDocument();
    expect(
      screen.getByText(/individual tile proofs do not/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not re-query and validate/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/51ec6b868d563b86dadc174956eb5ab5998cef6b/),
    ).toBeInTheDocument();
    expect(screen.getByText(/20,004 reads/)).toBeInTheDocument();
    expect(
      screen.getByText(/complete commit or complete revert/),
    ).toBeInTheDocument();
  });

  test("qualifies stale headline evidence and excludes rejected identities", () => {
    const stale = evidenceReducer(state, {
      type: "chain-failed",
      condition: "unavailable",
      error: "RPC unavailable",
    });
    const { unmount } = render(
      <EvidencePipeline
        config={config}
        state={stale}
        relationship={reconcileEvidence(stale, config)}
        onRetry={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Last observed eligible source block"),
    ).toBeInTheDocument();
    unmount();

    const conflicting = evidenceReducer(state, {
      type: "chain-read",
      value: {
        ...state.chain.value!,
        generation: "2",
        population: "32770",
        stateDigest: `0x${"ee".repeat(32)}`,
      },
    });
    render(
      <EvidencePipeline
        config={config}
        state={conflicting}
        relationship={reconcileEvidence(conflicting, config)}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Rejected snapshot identity")).toBeInTheDocument();
    const bundle = screen.getByRole("heading", {
      name: "Inspectable claim bundle",
    }).parentElement!;
    expect(bundle).not.toHaveTextContent("Latest eligible source block");
    expect(bundle).toHaveTextContent(/Event provenanceNot available/);
  });

  test("uses questions rather than unsupported rankings", () => {
    const { container } = render(<ComparisonFramework />);
    expect(
      screen.getByRole("heading", {
        name: "Ask the same atomic workload of every system",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Workload comparison questions" }),
    ).toHaveTextContent(
      /Admission[\s\S]*Execution[\s\S]*State delta[\s\S]*Block production[\s\S]*Finality[\s\S]*Data availability/,
    );
    expect(
      screen.getByText(/before receiving any pass, fail/),
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent(
      /\b(only|first|impossible elsewhere)\b/i,
    );
  });
});
