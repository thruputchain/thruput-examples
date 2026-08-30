import type { ReadAppConfig } from "@/config";
import {
  markChainReadFailed,
  reconcileChainMetadata,
} from "@/chain/metadata-state";
import type { ChainMetadata } from "@/chain/game-of-life";
import type { ImmutableSnapshot } from "@/indexer/client";
import { assertSnapshotEligible } from "@/indexer/schema";

export type EvidenceStatus =
  "loading" | "ready" | "stale" | "unavailable" | "malformed";

export interface EvidenceSource<T> {
  readonly status: EvidenceStatus;
  readonly value: T | null;
  readonly error: string | null;
  readonly failure: "unavailable" | "malformed" | null;
}

export interface XrayEvidenceState {
  readonly chain: EvidenceSource<ChainMetadata> & {
    readonly integrity: boolean;
  };
  readonly snapshot: EvidenceSource<ImmutableSnapshot>;
}

export type EvidenceAction =
  | { readonly type: "chain-read"; readonly value: ChainMetadata }
  | {
      readonly type: "chain-failed";
      readonly condition: "unavailable" | "malformed";
      readonly error: string;
    }
  | { readonly type: "snapshot-read"; readonly value: ImmutableSnapshot }
  | {
      readonly type: "snapshot-failed";
      readonly condition: "unavailable" | "malformed";
      readonly error: string;
    };

export type EvidenceRelationship =
  | "no-live-evidence"
  | "chain-only"
  | "aligned"
  | "indexer-behind"
  | "snapshot-retained"
  | "incompatible"
  | "integrity-conflict";

export interface ReconciledEvidence {
  readonly relationship: EvidenceRelationship;
  readonly label: string;
  readonly detail: string;
  readonly stale: boolean;
}

export const INITIAL_EVIDENCE_STATE: XrayEvidenceState = {
  chain: {
    status: "loading",
    value: null,
    error: null,
    failure: null,
    integrity: false,
  },
  snapshot: {
    status: "loading",
    value: null,
    error: null,
    failure: null,
  },
};

export function evidenceReducer(
  state: XrayEvidenceState,
  action: EvidenceAction,
): XrayEvidenceState {
  switch (action.type) {
    case "chain-read": {
      const next = reconcileChainMetadata(
        {
          chain: state.chain.value,
          chainError: state.chain.error,
          chainVerification: state.chain.integrity ? "integrity" : "loading",
        },
        action.value,
      );
      return {
        ...state,
        chain: {
          status: "ready",
          value: next.chain,
          error: next.chainError,
          failure: null,
          integrity: next.chainVerification === "integrity",
        },
      };
    }
    case "chain-failed": {
      const next = markChainReadFailed(
        {
          chain: state.chain.value,
          chainError: state.chain.error,
          chainVerification: state.chain.integrity
            ? "integrity"
            : state.chain.status === "ready"
              ? "fresh"
              : state.chain.status === "stale"
                ? "stale"
                : "loading",
        },
        action.error,
      );
      return {
        ...state,
        chain: {
          status: next.chain ? "stale" : action.condition,
          value: next.chain,
          error: next.chainError,
          failure: action.condition,
          integrity: next.chainVerification === "integrity",
        },
      };
    }
    case "snapshot-read":
      return {
        ...state,
        snapshot: {
          status: "ready",
          value: action.value,
          error: null,
          failure: null,
        },
      };
    case "snapshot-failed":
      return {
        ...state,
        snapshot: {
          status: state.snapshot.value ? "stale" : action.condition,
          value: state.snapshot.value,
          error: action.error,
          failure: action.condition,
        },
      };
  }
}

export function reconcileEvidence(
  state: XrayEvidenceState,
  scope: Pick<ReadAppConfig, "networkId" | "contractAddress">,
): ReconciledEvidence {
  const chain = state.chain.value;
  const snapshot = state.snapshot.value;
  const stale =
    state.chain.status === "stale" || state.snapshot.status === "stale";
  const prefix = stale ? "Last observed: " : "";

  if (state.snapshot.failure === "malformed")
    return result(
      "incompatible",
      snapshot
        ? "Retained snapshot; incompatible refresh"
        : "Incompatible snapshot",
      state.snapshot.error ?? "Snapshot validation failed.",
      stale,
    );
  if (state.chain.integrity)
    return result(
      "integrity-conflict",
      `${prefix}Integrity conflict`,
      state.chain.error ?? "Chain metadata changed incompatibly.",
      stale,
    );
  if (!chain && !snapshot)
    return result(
      "no-live-evidence",
      "No live evidence",
      "Fixed contract-derived explanations remain available.",
      stale,
    );
  if (chain && !snapshot)
    return result(
      "chain-only",
      `${prefix}Chain only`,
      "Current chain metadata is available without validated visualization evidence.",
      stale,
    );
  if (!chain && snapshot)
    return result(
      "snapshot-retained",
      `${prefix}Snapshot retained`,
      "Indexed identity is retained evidence and is not labeled as current chain state.",
      stale,
    );

  try {
    assertSnapshotEligible(
      snapshot!.manifest,
      snapshot!.provenance,
      chain!,
      scope,
    );
  } catch (cause) {
    return result(
      "integrity-conflict",
      `${prefix}Integrity conflict`,
      message(cause),
      stale,
    );
  }

  if (snapshot!.manifest.generation === chain!.generation)
    return result(
      "aligned",
      `${prefix}Chain and snapshot aligned`,
      `Both sources identify generation ${chain!.generation}.`,
      stale,
    );
  return result(
    "indexer-behind",
    `${prefix}Indexer behind`,
    `Chain generation ${chain!.generation}; eligible event-backed snapshot generation ${snapshot!.manifest.generation}.`,
    stale,
  );
}

function result(
  relationship: EvidenceRelationship,
  label: string,
  detail: string,
  stale: boolean,
): ReconciledEvidence {
  return { relationship, label, detail, stale };
}

export function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Evidence request failed";
}
