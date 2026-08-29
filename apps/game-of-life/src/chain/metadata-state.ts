import type { ChainMetadata } from "./game-of-life";

export type ChainVerification =
  "loading" | "fresh" | "stale" | "unavailable" | "integrity";

export interface ChainState {
  readonly chain: ChainMetadata | null;
  readonly chainError: string | null;
  readonly chainVerification: ChainVerification;
}

export function reconcileChainMetadata<T extends ChainState>(
  current: T,
  next: ChainMetadata,
): T {
  if (!current.chain)
    return {
      ...current,
      chain: next,
      chainError: null,
      chainVerification: "fresh",
    };
  const generation = BigInt(next.generation);
  const currentGeneration = BigInt(current.chain.generation);
  if (generation < currentGeneration)
    return {
      ...current,
      chainError: "Chain metadata regressed to an older generation",
      chainVerification: "integrity",
    };
  if (
    generation === currentGeneration &&
    !sameChainIdentity(current.chain, next)
  )
    return {
      ...current,
      chainError:
        "Conflicting metadata was returned for the current generation",
      chainVerification: "integrity",
    };
  return {
    ...current,
    chain: next,
    chainError: null,
    chainVerification: "fresh",
  };
}

export function markChainReadFailed<T extends ChainState>(
  current: T,
  error: string,
): T {
  if (current.chainVerification === "integrity") return current;
  return {
    ...current,
    chainError: error,
    chainVerification: current.chain ? "stale" : "unavailable",
  };
}

function sameChainIdentity(left: ChainMetadata, right: ChainMetadata): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.generation === right.generation &&
    left.seed === right.seed &&
    left.population === right.population &&
    left.stateDigest === right.stateDigest
  );
}
