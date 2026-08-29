import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ActivityContent, DetailsContent, GenerationReadout } from "./app";
import type { ImmutableSnapshot } from "./indexer/client";
import {
  INITIAL_SYNCHRONIZATION_STATE,
  type SynchronizationState,
} from "./synchronization";

const digest = `0x${"aa".repeat(32)}`;
const snapshot = {
  manifest: {
    networkId: "11".repeat(32),
    contractAddress: `0x${"22".repeat(32)}`,
    generation: "3",
    population: "32768",
    stateDigest: digest,
    seed: "7",
    width: 10000,
    height: 10000,
  },
  provenance: {
    sourceBlockHeight: "12",
    sourceBlockHash: `0x${"bb".repeat(32)}`,
    evidenceKind: "generation-advanced-event",
  },
} as ImmutableSnapshot;

const state = {
  ...INITIAL_SYNCHRONIZATION_STATE,
  chain: {
    width: 10000,
    height: 10000,
    generation: "5",
    seed: "7",
    population: "32770",
    stateDigest: `0x${"cc".repeat(32)}`,
    chunkBytes: 1000,
    chunksPerRow: 2,
    maxQueueLength: 16,
  },
  chainVerification: "fresh",
  visualized: snapshot,
  candidate: {
    ...snapshot,
    manifest: { ...snapshot.manifest, generation: "4" },
  },
  transition: "staging",
} satisfies SynchronizationState;

afterEach(cleanup);

describe("Phase 5 instrument surfaces", () => {
  test("keeps chain, preparing, and visualized generations distinct", () => {
    render(<ActivityContent state={state} />);
    expect(screen.getByText("Generation 5")).toBeInTheDocument();
    expect(screen.getByText("Generation 4")).toBeInTheDocument();
    expect(screen.getByText("Generation 3")).toBeInTheDocument();
    expect(screen.getByText("Displaying older generation")).toBeInTheDocument();
  });

  test("labels the retained visualization honestly while staging", () => {
    render(<GenerationReadout state={state} />);
    expect(screen.getByText("Preparing visualization 4")).toBeInTheDocument();
  });

  test("does not call a retained visualization ready during integrity failure", () => {
    render(
      <GenerationReadout
        state={{
          ...state,
          candidate: null,
          transition: "idle",
          chainVerification: "integrity",
        }}
      />,
    );
    expect(
      screen.getByText("Chain integrity warning · retained generation 3"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Ready/)).not.toBeInTheDocument();
  });

  test("states complete-world and tile verification boundaries", () => {
    render(
      <DetailsContent
        state={state}
        config={
          {
            contractAddress: snapshot.manifest.contractAddress,
          } as never
        }
      />,
    );
    expect(
      screen.getByText(/reads, computes, and commits the exact next state/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/individual tiles do not carry proofs/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/derives visualization artifacts from committed state/),
    ).toBeInTheDocument();
  });

  test("stale health does not remove verified static snapshot state", () => {
    render(<ActivityContent state={state} />);
    expect(screen.getByText("Indexer status unavailable")).toBeInTheDocument();
    expect(screen.getByText("Generation 3")).toBeInTheDocument();
  });

  test("distinguishes verified metadata from active initial ownership", () => {
    render(
      <ActivityContent
        state={{ ...state, visualized: null }}
        rendererAvailability="available"
      />,
    );
    expect(screen.getByText("No active visualization")).toBeInTheDocument();
    expect(
      screen.getByText("Verified snapshot is loading renderer coverage"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Actively displayed")).not.toBeInTheDocument();
  });

  test("does not label retained metadata as visualized without WebGL", () => {
    render(
      <ActivityContent state={state} rendererAvailability="unavailable" />,
    );
    expect(
      screen.getByText("Unavailable", { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Renderer unavailable; verified metadata retained"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Actively displayed")).not.toBeInTheDocument();
  });
});
