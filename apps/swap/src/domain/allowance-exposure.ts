import type { CreationWorkflow } from "@/transactions/creation-workflow";
import type { LiquidityOperation } from "@/transactions/liquidity-operation";
import {
  hasExecutionExposure,
  type RequestRecord,
} from "@/transactions/request-collection";

export interface AccountAllowanceRecords {
  requests: readonly RequestRecord[];
  liquidityOperations: readonly LiquidityOperation[];
  creationWorkflows: readonly CreationWorkflow[];
}

export interface CleanupAllowanceRequirement {
  requiredAllowance: bigint;
  minimumReadHeight: bigint;
}

export function requiredAllowanceFor(
  records: AccountAllowanceRecords,
  tokenAddress: string,
  handlerAddress: string,
): bigint {
  let required = 0n;
  for (const request of records.requests) {
    if (
      hasExecutionExposure(request)
      && request.criteria.tokenIn === tokenAddress
      && request.criteria.handlerAddress === handlerAddress
    ) required += request.intent.amountIn;
  }
  for (const operation of records.liquidityOperations) {
    if (
      (operation.status !== "active" && operation.status !== "queued")
      || operation.handlerAddress !== handlerAddress
    ) continue;
    if (operation.kind === "add") {
      if (operation.token0Address === tokenAddress) {
        required += BigInt(operation.intent.amountsDesired[0]);
      }
      if (operation.token1Address === tokenAddress) {
        required += BigInt(operation.intent.amountsDesired[1]);
      }
    } else if (operation.liquidityTokenAddress === tokenAddress) {
      required += BigInt(operation.intent.liquidity);
    }
  }
  for (const workflow of records.creationWorkflows) {
    if (
      (workflow.status !== "active"
        && workflow.status !== "queued"
        && !(workflow.status === "race" && workflow.requestId !== null))
      || workflow.pool.handler !== handlerAddress
    ) continue;
    if (workflow.token0.address === tokenAddress) {
      required += BigInt(workflow.token0.amount);
    }
    if (workflow.token1.address === tokenAddress) {
      required += BigInt(workflow.token1.amount);
    }
  }
  return required;
}

export function cleanupAllowanceRequirementFor(
  records: AccountAllowanceRecords,
  tokenAddress: string,
  handlerAddress: string,
): CleanupAllowanceRequirement {
  let requiredAllowance = requiredAllowanceFor(
    records,
    tokenAddress,
    handlerAddress,
  );
  let minimumReadHeight = 0n;
  const includeTerminal = (block: string | null | undefined, amount: bigint) => {
    if (block === undefined || block === null) {
      requiredAllowance += amount;
    } else {
      const height = BigInt(block);
      if (height > minimumReadHeight) minimumReadHeight = height;
    }
  };

  for (const request of records.requests) {
    if (
      request.execution !== null
      && request.criteria.tokenIn === tokenAddress
      && request.criteria.handlerAddress === handlerAddress
    ) {
      const height = request.execution.blockHeight;
      if (height > minimumReadHeight) minimumReadHeight = height;
    }
  }
  for (const operation of records.liquidityOperations) {
    if (
      (operation.status !== "executed" && operation.status !== "failed")
      || operation.handlerAddress !== handlerAddress
    ) continue;
    if (operation.kind === "add") {
      if (operation.token0Address === tokenAddress) {
        includeTerminal(
          operation.terminalBlock,
          BigInt(operation.intent.amountsDesired[0]),
        );
      }
      if (operation.token1Address === tokenAddress) {
        includeTerminal(
          operation.terminalBlock,
          BigInt(operation.intent.amountsDesired[1]),
        );
      }
    } else if (operation.liquidityTokenAddress === tokenAddress) {
      includeTerminal(operation.terminalBlock, BigInt(operation.intent.liquidity));
    }
  }
  for (const workflow of records.creationWorkflows) {
    if (
      (workflow.status !== "executed" && workflow.status !== "failed")
      || workflow.pool.handler !== handlerAddress
    ) continue;
    if (workflow.token0.address === tokenAddress) {
      includeTerminal(workflow.terminalBlock, BigInt(workflow.token0.amount));
    }
    if (workflow.token1.address === tokenAddress) {
      includeTerminal(workflow.terminalBlock, BigInt(workflow.token1.amount));
    }
  }
  return { requiredAllowance, minimumReadHeight };
}
