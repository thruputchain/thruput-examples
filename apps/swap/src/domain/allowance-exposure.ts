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
  spenderAddress: string,
): bigint {
  let required = 0n;
  for (const request of records.requests) {
    if (
      hasExecutionExposure(request)
      && request.criteria.tokenIn === tokenAddress
      && request.criteria.handlerAddress === spenderAddress
    ) required += request.intent.amountIn;
  }
  for (const operation of records.liquidityOperations) {
    if (
      (operation.status !== "active" && operation.status !== "queued")
      || operation.handlerAddress !== spenderAddress
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
        && workflow.status !== "queued")
      || workflow.pool?.handler !== spenderAddress
    ) continue;
    if (workflow.token0.address === tokenAddress) {
      required += BigInt(workflow.token0.amount);
    }
    if (workflow.token1.address === tokenAddress) {
      required += BigInt(workflow.token1.amount);
    }
  }
  for (const workflow of records.creationWorkflows) {
    if (
      workflow.nativeHogAddress === tokenAddress
      && workflow.factoryAddress === spenderAddress
      && workflow.status === "active"
      && workflow.steps.createPool.status !== "committed"
    ) required += BigInt(workflow.totalFunding);
  }
  return required;
}

export function cleanupAllowanceRequirementFor(
  records: AccountAllowanceRecords,
  tokenAddress: string,
  spenderAddress: string,
): CleanupAllowanceRequirement {
  let requiredAllowance = requiredAllowanceFor(
    records,
    tokenAddress,
    spenderAddress,
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
      && request.criteria.handlerAddress === spenderAddress
    ) {
      const height = request.execution.blockHeight;
      if (height > minimumReadHeight) minimumReadHeight = height;
    }
  }
  for (const operation of records.liquidityOperations) {
    if (
      (operation.status !== "executed" && operation.status !== "failed")
      || operation.handlerAddress !== spenderAddress
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
      || workflow.pool?.handler !== spenderAddress
    ) continue;
    if (workflow.token0.address === tokenAddress) {
      includeTerminal(workflow.terminalBlock, BigInt(workflow.token0.amount));
    }
    if (workflow.token1.address === tokenAddress) {
      includeTerminal(workflow.terminalBlock, BigInt(workflow.token1.amount));
    }
  }
  for (const workflow of records.creationWorkflows) {
    if (
      workflow.nativeHogAddress !== tokenAddress
      || workflow.factoryAddress !== spenderAddress
      || workflow.steps.approveFunding.status !== "committed"
    ) continue;
    const block = workflow.steps.createPool.receiptBlock
      ?? workflow.steps.approveFunding.receiptBlock;
    if (block !== null && BigInt(block) > minimumReadHeight) {
      minimumReadHeight = BigInt(block);
    }
  }
  return { requiredAllowance, minimumReadHeight };
}
