import type { ChainMetadata } from "@/chain/game-of-life";
import {
  markChainReadFailed,
  reconcileChainMetadata,
  type ChainVerification,
} from "@/chain/metadata-state";
import type { ImmutableSnapshot } from "@/indexer/client";
import type { LifeStatus } from "@/indexer/schema";

export type ArtifactState =
  | "idle"
  | "loading"
  | "awaiting-chain"
  | "ready"
  | "unavailable"
  | "malformed"
  | "invalid";
export type TransitionState = "idle" | "staging" | "crossfading";
export type StatusEndpointState = "fresh" | "unavailable" | "malformed";
export type RendererAvailability =
  "initializing" | "available" | "context-lost" | "unavailable";

export interface SynchronizationState {
  readonly chain: ChainMetadata | null;
  readonly chainError: string | null;
  readonly chainVerification: ChainVerification;
  readonly visualized: ImmutableSnapshot | null;
  readonly candidate: ImmutableSnapshot | null;
  readonly candidateEpoch: number | null;
  readonly nextEpoch: number;
  readonly pendingSnapshot: ImmutableSnapshot | null;
  readonly artifactState: ArtifactState;
  readonly artifactError: string | null;
  readonly transition: TransitionState;
  readonly status: LifeStatus | null;
  readonly statusEndpoint: StatusEndpointState;
  readonly statusError: string | null;
}

export const INITIAL_SYNCHRONIZATION_STATE: SynchronizationState = {
  chain: null,
  chainError: null,
  chainVerification: "loading",
  visualized: null,
  candidate: null,
  candidateEpoch: null,
  nextEpoch: 1,
  pendingSnapshot: null,
  artifactState: "idle",
  artifactError: null,
  transition: "idle",
  status: null,
  statusEndpoint: "unavailable",
  statusError: null,
};

export type SynchronizationAction =
  | { readonly type: "chain-read"; readonly value: ChainMetadata }
  | { readonly type: "chain-failed"; readonly error: string }
  | { readonly type: "artifact-loading" }
  | { readonly type: "artifact-unchanged" }
  | { readonly type: "artifact-parsed"; readonly snapshot: ImmutableSnapshot }
  | {
      readonly type: "artifact-failed";
      readonly condition: "unavailable" | "malformed";
      readonly error: string;
    }
  | { readonly type: "candidate-ready"; readonly snapshot: ImmutableSnapshot }
  | { readonly type: "candidate-invalid"; readonly error: string }
  | { readonly type: "transition"; readonly value: TransitionState }
  | {
      readonly type: "visualization-committed";
      readonly digest: string;
      readonly epoch: number;
    }
  | { readonly type: "status-read"; readonly value: LifeStatus }
  | {
      readonly type: "status-failed";
      readonly condition: "unavailable" | "malformed";
      readonly error: string;
    };

export function synchronizationReducer(
  state: SynchronizationState,
  action: SynchronizationAction,
): SynchronizationState {
  switch (action.type) {
    case "chain-read": {
      const next = reconcileChainMetadata(state, action.value);
      return next.chainVerification === "integrity"
        ? clearCandidate(
            next,
            next.chainError ?? "Chain metadata integrity failure",
          )
        : next;
    }
    case "chain-failed":
      return markChainReadFailed(state, action.error);
    case "artifact-loading":
      return { ...state, artifactState: "loading", artifactError: null };
    case "artifact-unchanged":
      return {
        ...state,
        artifactState: state.pendingSnapshot ? "awaiting-chain" : "ready",
        artifactError: null,
      };
    case "artifact-parsed":
      return {
        ...state,
        pendingSnapshot: action.snapshot,
        artifactState: "awaiting-chain",
        artifactError: null,
      };
    case "artifact-failed":
      return {
        ...state,
        artifactState: action.condition,
        artifactError: action.error,
      };
    case "candidate-invalid":
      return clearCandidate(
        {
          ...state,
          pendingSnapshot: null,
          artifactState: "invalid",
        },
        action.error,
      );
    case "candidate-ready": {
      const next = action.snapshot;
      const current = state.candidate ?? state.visualized;
      if (current) {
        const order = compareSnapshot(next, current);
        if (order < 0)
          return {
            ...state,
            pendingSnapshot: null,
            artifactState: "ready",
            artifactError: null,
          };
        if (order === 0) {
          if (next.manifest.stateDigest === current.manifest.stateDigest)
            return {
              ...state,
              pendingSnapshot: null,
              artifactState: "ready",
              artifactError: null,
            };
          return clearCandidate(
            { ...state, pendingSnapshot: null, artifactState: "invalid" },
            "Indexer returned conflicting digests for one generation",
          );
        }
      }
      return {
        ...state,
        candidate: next,
        candidateEpoch: state.nextEpoch,
        nextEpoch: state.nextEpoch + 1,
        pendingSnapshot: null,
        artifactState: "ready",
        artifactError: null,
        transition: "staging",
      };
    }
    case "transition":
      return state.candidate
        ? { ...state, transition: action.value }
        : { ...state, transition: "idle" };
    case "visualization-committed":
      if (
        state.candidate?.manifest.stateDigest !== action.digest ||
        state.candidateEpoch !== action.epoch ||
        state.chainVerification === "integrity"
      )
        return state;
      return {
        ...state,
        visualized: state.candidate,
        candidate: null,
        candidateEpoch: null,
        transition: "idle",
        artifactState: "ready",
      };
    case "status-read":
      return {
        ...state,
        status: action.value,
        statusEndpoint: "fresh",
        statusError: null,
      };
    case "status-failed":
      return {
        ...state,
        statusEndpoint: action.condition,
        statusError: action.error,
      };
  }
}

function clearCandidate(
  state: SynchronizationState,
  error: string,
): SynchronizationState {
  return {
    ...state,
    candidate: null,
    candidateEpoch: null,
    transition: "idle",
    artifactError: error,
  };
}

function compareSnapshot(
  left: ImmutableSnapshot,
  right: ImmutableSnapshot,
): number {
  const a = BigInt(left.manifest.generation);
  const b = BigInt(right.manifest.generation);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isStatusStale(
  status: LifeStatus | null,
  now = Date.now(),
): boolean {
  return status === null || now - Date.parse(status.heartbeatAt) >= 15_000;
}
