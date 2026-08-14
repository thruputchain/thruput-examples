import type { RequestRecord } from "@/transactions/request-collection";

export function hasExecutionExposure(request: RequestRecord): boolean {
  return request.status === "submitting"
    || (request.status === "indeterminate" && request.phase === "swap")
    || request.status === "queued"
    || request.status === "queuedNotObserved"
    || request.status === "queuedUntracked";
}

export function reservedInputForToken(
  requests: readonly RequestRecord[],
  tokenAddress: string,
): bigint {
  let reserved = 0n;
  for (const request of requests) {
    if (
      hasExecutionExposure(request)
      && request.criteria.tokenIn === tokenAddress
    ) {
      reserved += request.intent.amountIn;
    }
  }
  return reserved;
}

export function availableBalance(balance: bigint, reserved: bigint): bigint {
  if (balance < 0n || reserved < 0n) {
    throw new RangeError("Balances and reservations cannot be negative");
  }
  return balance > reserved ? balance - reserved : 0n;
}

export function allowanceTargetForSwap(
  requests: readonly RequestRecord[],
  tokenAddress: string,
  amountIn: bigint,
): bigint {
  if (amountIn < 0n) throw new RangeError("Swap input cannot be negative");
  return reservedInputForToken(requests, tokenAddress) + amountIn;
}
