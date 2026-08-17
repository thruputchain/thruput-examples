import { toHex0x } from "@groundhogchain/client";

import { orientReserves, orderTokens } from "@/domain/tokens";
import type { PoolSnapshot, TokenSnapshot } from "@/swap/snapshot";
import type { OutstandingRequest } from "@/transactions/outstanding-request";
import type { RequestRecord } from "@/transactions/request-collection";
import type { RequestObservation } from "@/transactions/request-observer";

type ObservableRequest = Omit<OutstandingRequest, "status">;

export function inferExecutionFromSnapshot(
  request: ObservableRequest,
  snapshot: PoolSnapshot,
): Extract<RequestObservation, { kind: "executionInferred" }> | null {
  const baseline = request.observationBaseline;
  if (
    baseline === null
    || request.requestId === null
    || request.transactionHash === null
    || request.receiptBlock === null
    || snapshot.chainHeight <= request.receiptBlock
    || snapshot.chainHeight <= baseline.chainHeight
  ) return null;

  const input = tokenByAddress(snapshot, request.criteria.tokenIn);
  const output = tokenByAddress(snapshot, request.criteria.tokenOut);
  if (input === null || output === null) return null;
  const inputIndex = orderTokens(input.address, output.address).inputIndex;
  const reserves = orientReserves(
    [snapshot.reserve0, snapshot.reserve1],
    inputIndex,
  );
  if (
    baseline.inputBalance < request.intent.amountIn
    || baseline.inputAllowance < request.intent.amountIn
    || baseline.reserveOut < request.intent.amountOutMin
  ) return null;

  const amountIn = baseline.inputBalance - input.balance;
  const amountOut = output.balance - baseline.outputBalance;
  if (
    amountIn !== request.intent.amountIn
    || amountOut < request.intent.amountOutMin
    || amountOut <= 0n
    || input.allowance !== baseline.inputAllowance - amountIn
    || reserves.reserveIn !== baseline.reserveIn + amountIn
    || reserves.reserveOut !== baseline.reserveOut - amountOut
  ) return null;

  return {
    kind: "executionInferred",
    requestId: request.requestId,
    transactionHash: request.transactionHash,
    blockHeight: snapshot.chainHeight,
    amountIn,
    amountOut,
  };
}

export function inferSingleExecutionFromSnapshot(
  requests: readonly RequestRecord[],
  snapshot: PoolSnapshot,
): Extract<RequestObservation, { kind: "executionInferred" }> | null {
  if (
    requests.length !== 1
    || !requests[0]!.snapshotInferenceEligible
    || requests[0]!.observationBaseline === null
  ) {
    return null;
  }
  return inferExecutionFromSnapshot(requests[0]!, snapshot);
}

function tokenByAddress(
  snapshot: PoolSnapshot,
  address: string,
): TokenSnapshot | null {
  if (toHex0x(snapshot.tokenA.address) === address) return snapshot.tokenA;
  if (toHex0x(snapshot.tokenB.address) === address) return snapshot.tokenB;
  return null;
}
