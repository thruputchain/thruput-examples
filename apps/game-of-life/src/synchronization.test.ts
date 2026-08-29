import { describe, expect, test } from "vitest";
import type { ImmutableSnapshot } from "./indexer/client";
import {
  INITIAL_SYNCHRONIZATION_STATE,
  isStatusStale,
  synchronizationReducer,
} from "./synchronization";

function snapshot(generation: string, byte: string): ImmutableSnapshot {
  return {
    manifest: {
      generation,
      stateDigest: `0x${byte.repeat(64)}`,
    },
  } as ImmutableSnapshot;
}

function stage(
  state: typeof INITIAL_SYNCHRONIZATION_STATE,
  value: ImmutableSnapshot,
) {
  return synchronizationReducer(state, {
    type: "candidate-ready",
    snapshot: value,
  });
}

function commit(state: ReturnType<typeof stage>) {
  return synchronizationReducer(state, {
    type: "visualization-committed",
    digest: state.candidate!.manifest.stateDigest,
    epoch: state.candidateEpoch!,
  });
}

describe("generation synchronization", () => {
  test("stages the first eligible snapshot without assigning ownership", () => {
    const first = snapshot("0", "a");
    const state = stage(INITIAL_SYNCHRONIZATION_STATE, first);
    expect(state.visualized).toBeNull();
    expect(state.candidate).toBe(first);
    expect(state.candidateEpoch).toBe(1);
    expect(state.transition).toBe("staging");
  });

  test("keeps a verified visualization while a newer candidate is staged", () => {
    const first = snapshot("4", "a");
    const next = snapshot("5", "b");
    let state = commit(stage(INITIAL_SYNCHRONIZATION_STATE, first));
    state = stage(state, next);
    expect(state.visualized).toBe(first);
    expect(state.candidate).toBe(next);
    expect(state.transition).toBe("staging");
  });

  test("commits only the exact staged digest", () => {
    const first = snapshot("4", "a");
    const next = snapshot("5", "b");
    let state = commit(stage(INITIAL_SYNCHRONIZATION_STATE, first));
    state = stage(state, next);
    expect(
      synchronizationReducer(state, {
        type: "visualization-committed",
        digest: first.manifest.stateDigest,
        epoch: state.candidateEpoch!,
      }).visualized,
    ).toBe(first);
    state = synchronizationReducer(state, {
      type: "visualization-committed",
      digest: next.manifest.stateDigest,
      epoch: state.candidateEpoch!,
    });
    expect(state.visualized).toBe(next);
    expect(state.candidate).toBeNull();
  });

  test("rejects regressions and equal-generation digest conflicts", () => {
    const current = commit(
      stage(INITIAL_SYNCHRONIZATION_STATE, snapshot("5", "a")),
    );
    expect(
      synchronizationReducer(current, {
        type: "candidate-ready",
        snapshot: snapshot("4", "b"),
      }).visualized,
    ).toBe(current.visualized);
    const conflict = synchronizationReducer(current, {
      type: "candidate-ready",
      snapshot: snapshot("5", "b"),
    });
    expect(conflict.artifactError).toMatch(/conflicting digests/);
    expect(conflict.visualized).toBe(current.visualized);
  });

  test("status availability never removes a verified visualization", () => {
    const ready = commit(
      stage(INITIAL_SYNCHRONIZATION_STATE, snapshot("5", "a")),
    );
    const unavailable = synchronizationReducer(ready, {
      type: "status-failed",
      condition: "unavailable",
      error: "offline",
    });
    expect(unavailable.visualized).toBe(ready.visualized);
    expect(unavailable.statusEndpoint).toBe("unavailable");
  });

  test("clears a staged epoch on chain integrity and rejects its stale commit", () => {
    const first = snapshot("4", "a");
    const next = snapshot("5", "b");
    let state = commit(stage(INITIAL_SYNCHRONIZATION_STATE, first));
    state = stage(state, next);
    const epoch = state.candidateEpoch!;
    state = synchronizationReducer(
      {
        ...state,
        chain: {
          width: 10000,
          height: 10000,
          generation: "5",
          seed: "7",
          population: "1",
          stateDigest: next.manifest.stateDigest,
          chunkBytes: 1000,
          chunksPerRow: 2,
          maxQueueLength: 16,
        },
        chainVerification: "fresh",
      },
      {
        type: "chain-read",
        value: {
          width: 10000,
          height: 10000,
          generation: "5",
          seed: "7",
          population: "2",
          stateDigest: next.manifest.stateDigest,
          chunkBytes: 1000,
          chunksPerRow: 2,
          maxQueueLength: 16,
        },
      },
    );
    expect(state.candidate).toBeNull();
    expect(state.transition).toBe("idle");
    expect(
      synchronizationReducer(state, {
        type: "visualization-committed",
        digest: next.manifest.stateDigest,
        epoch,
      }).visualized,
    ).toBe(first);
  });

  test("treats a heartbeat as stale at exactly fifteen seconds", () => {
    const heartbeatAt = "2026-08-29T12:00:00Z";
    const status = { heartbeatAt } as never;
    expect(isStatusStale(status, Date.parse(heartbeatAt) + 14_999)).toBe(false);
    expect(isStatusStale(status, Date.parse(heartbeatAt) + 15_000)).toBe(true);
  });
});
