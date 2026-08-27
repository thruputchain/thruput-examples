import type { AppConfig } from "@/config";
import {
  cleanupAllowanceRequirementFor,
  requiredAllowanceFor,
  type AccountAllowanceRecords,
} from "@/domain/allowance-exposure";
import { loadAccountCreationWorkflows } from "@/transactions/creation-workflow";
import { loadAccountLiquidityOperations } from "@/transactions/liquidity-operation";
import { loadAccountRequestRecords } from "@/transactions/request-collection";
import { loadAllowanceTerminalHeight } from "@/transactions/allowance-evidence";

export function loadAccountAllowanceRecords(
  config: AppConfig,
): AccountAllowanceRecords {
  return {
    requests: loadAccountRequestRecords(config),
    liquidityOperations: loadAccountLiquidityOperations(config),
    creationWorkflows: loadAccountCreationWorkflows(config),
  };
}

export function loadCleanupAllowanceRequirement(
  config: AppConfig,
  tokenAddress: string,
  handlerAddress: string,
): ReturnType<typeof cleanupAllowanceRequirementFor> {
  const requirement = cleanupAllowanceRequirementFor(
    loadAccountAllowanceRecords(config),
    tokenAddress,
    handlerAddress,
  );
  const retainedHeight = loadAllowanceTerminalHeight(
    config,
    tokenAddress,
    handlerAddress,
  );
  return {
    ...requirement,
    minimumReadHeight: retainedHeight > requirement.minimumReadHeight
      ? retainedHeight
      : requirement.minimumReadHeight,
  };
}

export function loadRequiredAllowance(
  config: AppConfig,
  tokenAddress: string,
  handlerAddress: string,
): bigint {
  return requiredAllowanceFor(
    loadAccountAllowanceRecords(config),
    tokenAddress,
    handlerAddress,
  );
}
