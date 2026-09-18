import type { GlobalConfig } from "@/config";
import {
  cleanupAllowanceRequirementFor,
  requiredAllowanceFor,
  type AccountAllowanceRecords,
} from "@/domain/allowance-exposure";
import { loadAccountCreationWorkflows } from "@/transactions/creation-workflow";
import { loadAccountLiquidityOperations } from "@/transactions/liquidity-operation";
import { loadAccountRequestRecords } from "@/transactions/request-collection";
import { loadAllowanceTerminalHeight } from "@/transactions/allowance-evidence";

function loadAccountAllowanceRecords(
  config: GlobalConfig,
): AccountAllowanceRecords {
  return {
    requests: loadAccountRequestRecords(config),
    liquidityOperations: loadAccountLiquidityOperations(config),
    creationWorkflows: loadAccountCreationWorkflows(config),
  };
}

export function loadCleanupAllowanceRequirement(
  config: GlobalConfig,
  tokenAddress: string,
  spenderAddress: string,
): ReturnType<typeof cleanupAllowanceRequirementFor> {
  const requirement = cleanupAllowanceRequirementFor(
    loadAccountAllowanceRecords(config),
    tokenAddress,
    spenderAddress,
  );
  const retainedHeight = loadAllowanceTerminalHeight(
    config,
    tokenAddress,
    spenderAddress,
  );
  return {
    ...requirement,
    minimumReadHeight: retainedHeight > requirement.minimumReadHeight
      ? retainedHeight
      : requirement.minimumReadHeight,
  };
}

export function loadRequiredAllowance(
  config: GlobalConfig,
  tokenAddress: string,
  spenderAddress: string,
): bigint {
  return requiredAllowanceFor(
    loadAccountAllowanceRecords(config),
    tokenAddress,
    spenderAddress,
  );
}
