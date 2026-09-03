import { toHex0x, type TransactionReceipt } from "@groundhogchain/client";
import type { Invocation } from "@groundhogchain/protocol";

import type { AppConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import {
  buildProcessRequestsTarget,
  decodeRequestsProcessedSummary,
} from "@/contracts/driver-target";
import {
  liquidityFailureMessage,
  swapFailureMessage,
} from "@/contracts/failure-message";
import { RequestAccepted, RequestFailed } from "@/contracts/generated/swap-driver";
import { BurnEvent, MintEvent } from "@/contracts/generated/swap-handler";
import {
  buildAddLiquidityTarget,
  buildRemoveLiquidityTarget,
} from "@/contracts/router-target";
import { requiredAllowanceFor } from "@/domain/allowance-exposure";
import { reservedInputForToken } from "@/domain/reservations";
import { hasBlockingAllowanceCleanup } from "@/transactions/allowance-cleanup";
import {
  hasBlockingCreationTransaction,
  hasCreationExecutionExposure,
  loadAccountCreationWorkflows,
  reservedCreationToken,
  saveCreationWorkflow,
} from "@/transactions/creation-workflow";
import { applyCreationReceipt } from "@/transactions/creation-observer";
import {
  createCrankAttempt,
  isBlockingCrankAttempt,
  loadAccountCrankAttempts,
  loadCrankAttempt,
  saveCrankAttempt,
} from "@/transactions/crank-attempt";
import {
  hasBlockingLiquidityTransaction,
  hasLiquidityExecutionExposure,
  loadAccountLiquidityOperations,
  loadLiquidityOperations,
  reservedLiquidityTokenAmount,
  saveLiquidityOperations,
  upsertLiquidityOperation,
  type AddLiquidityOperation,
  type LiquidityOperation,
  type LiquidityStepName,
} from "@/transactions/liquidity-operation";
import type { LiquidityObserver } from "@/transactions/liquidity-observer";
import {
  hasExecutionExposure,
  loadAccountRequestRecords,
  loadRequestCollectionForUpdate,
  saveRequestCollection,
} from "@/transactions/request-collection";
import {
  applyObservationBatch,
  observationsFromReceipt,
} from "@/transactions/request-observer";
import type { SnapshotReader } from "@/swap/snapshot";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";

const MAX_EXECUTION_EXPOSURE = 10;

export interface LiquidityExecutorDependencies {
  writeBoundary: WriteBoundary;
  readSnapshot: SnapshotReader;
  onUpdate?: (operation: LiquidityOperation) => void;
  automaticProcessing?: boolean;
  observer?: LiquidityObserver;
}

export async function runLiquidityOperation(
  config: AppConfig,
  initial: LiquidityOperation,
  dependencies: LiquidityExecutorDependencies,
): Promise<LiquidityOperation> {
  let operation = authoritativeOperation(config, initial);
  const update = (next: LiquidityOperation): LiquidityOperation => {
    operation = next;
    saveLiquidityOperations(
      config,
      upsertLiquidityOperation(loadLiquidityOperations(config), next),
    );
    dependencies.onUpdate?.(next);
    return next;
  };
  const steps: readonly LiquidityStepName[] = operation.kind === "add"
    ? ["approveToken0", "approveToken1", "enqueue"]
    : ["approveLiquidity", "enqueue"];

  for (const name of steps) {
    if (operation.status !== "active") break;
    const step = operation.steps[name];
    if (step.status === "committed" || step.status === "skipped") continue;
    if (step.status === "signing" || step.status === "indeterminate") {
      if (step.transactionHash === null) {
        throw new Error("Confirm that the pre-hash transaction was never signed before retrying");
      }
      if (dependencies.writeBoundary.observe === undefined) {
        throw new Error("This wallet cannot recover the stored transaction");
      }
      const observed = await dependencies.writeBoundary.observe(step.transactionHash);
      operation = applyWriteResult(operation, name, observed, update);
      if (observed.kind !== "committedSuccess") return operation;
      operation = applyCommittedRouterStep(config, operation, name, observed.receipt, update);
      continue;
    }

    const snapshot = await dependencies.readSnapshot();
    assertAccountCanSign(config, operation, name);
    const target = targetForStep(config, operation, snapshot);
    if (target === null) {
      operation = update(updateStep(operation, name, {
        status: "skipped",
        transactionHash: null,
        message: null,
      }));
      continue;
    }
    operation = update(updateStep(operation, name, {
      status: "signing",
      transactionHash: null,
      message: null,
    }));
    const result = await dependencies.writeBoundary.execute(target, {
      onSigned: (transactionHash) => {
        operation = update(updateStep(operation, name, { transactionHash }));
      },
    });
    operation = applyWriteResult(operation, name, result, update);
    if (result.kind !== "committedSuccess") return operation;
    operation = applyCommittedRouterStep(config, operation, name, result.receipt, update);
  }

  if (operation.status !== "queued" || dependencies.automaticProcessing === false) {
    return operation;
  }
  if (dependencies.observer !== undefined) {
    operation = update(await dependencies.observer.scan(operation));
    if (operation.status !== "queued") {
      if (operation.kind === "add" && operation.status === "executed") {
        operation = verifyAddResult(operation, await dependencies.readSnapshot());
        update(operation);
      }
      return operation;
    }
  }
  const otherBlockingCrank = loadAccountCrankAttempts(config).find((attempt) =>
    isBlockingCrankAttempt(attempt)
    && attempt.driverAddress !== toHex0x(config.driverAddress)
  );
  if (otherBlockingCrank !== undefined) {
    throw new Error("Resolve the account's queue-processing transaction for another pool first");
  }
  const blockingCrank = loadCrankAttempt(config);
  if (blockingCrank !== null && isBlockingCrankAttempt(blockingCrank)) {
    if (blockingCrank.transactionHash === null) {
      throw new Error("Confirm that the pre-hash queue-processing transaction was never signed before retrying");
    }
    if (dependencies.writeBoundary.observe === undefined) {
      throw new Error("This wallet cannot recover the stored queue-processing transaction");
    }
    const observed = await dependencies.writeBoundary.observe(blockingCrank.transactionHash);
    if (observed.kind === "indeterminate") {
      saveCrankAttempt(config, {
        ...blockingCrank,
        status: "indeterminate",
        transactionHash: observed.hash ?? blockingCrank.transactionHash,
        message: "The queue-processing outcome remains uncertain.",
        updatedAt: Date.now(),
      });
      return operation;
    }
    if (observed.kind !== "committedSuccess") {
      saveCrankAttempt(config, {
        ...blockingCrank,
        status: "failed",
        transactionHash: observed.hash,
        message: crankFailureMessage(observed),
        updatedAt: Date.now(),
      });
      return operation;
    }
    saveCrankAttempt(config, {
      ...blockingCrank,
      status: "committed",
      transactionHash: observed.hash,
      message: null,
      updatedAt: Date.now(),
    });
    return reconcileCrankReceipt(config, operation, observed.receipt, dependencies, update);
  }
  assertAccountCanSign(config, operation, "enqueue");
  let crank = saveCrankAttempt(config, createCrankAttempt(config));
  const crankResult = await dependencies.writeBoundary.execute(
    buildProcessRequestsTarget(config.driverAddress),
    {
      onSigned: (transactionHash) => {
        crank = saveCrankAttempt(config, {
          ...crank,
          transactionHash,
          updatedAt: Date.now(),
        });
      },
    },
  );
  if (crankResult.kind === "indeterminate") {
    saveCrankAttempt(config, {
      ...crank,
      status: "indeterminate",
      transactionHash: crankResult.hash ?? crank.transactionHash,
      message: "The queue-processing outcome is uncertain.",
      updatedAt: Date.now(),
    });
    return operation;
  }
  if (crankResult.kind !== "committedSuccess") {
    saveCrankAttempt(config, {
      ...crank,
      status: "failed",
      transactionHash: crankResult.hash,
      message: crankFailureMessage(crankResult),
      updatedAt: Date.now(),
    });
    return operation;
  }
  saveCrankAttempt(config, {
    ...crank,
    status: "committed",
    transactionHash: crankResult.hash,
    message: null,
    updatedAt: Date.now(),
  });
  return reconcileCrankReceipt(config, operation, crankResult.receipt, dependencies, update);
}

export function confirmLiquidityStepWasNotSigned(
  config: AppConfig,
  operation: LiquidityOperation,
  expectedStep: LiquidityStepName,
): LiquidityOperation {
  const authoritative = authoritativeOperation(config, operation);
  const step = authoritative.steps[expectedStep];
  if (
    (step.status !== "signing" && step.status !== "indeterminate")
    || step.transactionHash !== null
  ) throw new Error("The liquidity operation advanced in another tab");
  const next = updateStep(authoritative, expectedStep, {
    status: "pending",
    transactionHash: null,
    message: "Confirmed locally as not signed",
  });
  saveLiquidityOperations(
    config,
    upsertLiquidityOperation(loadLiquidityOperations(config), next),
  );
  return next;
}

export function confirmLiquidityCrankWasNotSigned(config: AppConfig): void {
  const attempt = loadCrankAttempt(config);
  if (
    attempt === null
    || !isBlockingCrankAttempt(attempt)
    || attempt.transactionHash !== null
  ) {
    throw new Error("The queue-processing transaction advanced in another tab");
  }
  saveCrankAttempt(config, {
    ...attempt,
    status: "failed",
    message: "Confirmed locally as not signed",
    updatedAt: Date.now(),
  });
}

async function reconcileCrankReceipt(
  config: AppConfig,
  current: LiquidityOperation,
  receipt: TransactionReceipt,
  dependencies: LiquidityExecutorDependencies,
  update: (operation: LiquidityOperation) => LiquidityOperation,
): Promise<LiquidityOperation> {
  decodeRequestsProcessedSummary(receipt, config.driverAddress);
  const requests = loadRequestCollectionForUpdate(config);
  const queuedRequests = requests.filter(({ status, criteria }) =>
    status === "queued" && criteria.driverAddress === toHex0x(config.driverAddress)
  );
  if (queuedRequests.length > 0) {
    saveRequestCollection(
      config,
      applyObservationBatch(
        requests,
        queuedRequests,
        observationsFromReceipt(config, queuedRequests, receipt),
      ),
    );
  }
  for (const workflow of loadAccountCreationWorkflows(config)) {
    const next = applyCreationReceipt(workflow, receipt);
    if (next !== workflow) saveCreationWorkflow(config, next);
  }
  const reconciled = applyLiquidityReceipt(
    config,
    loadLiquidityOperations(config),
    receipt,
  );
  saveLiquidityOperations(config, reconciled);
  let operation = reconciled.find(({ id }) => id === current.id) ?? current;
  if (operation.kind === "add" && operation.status === "executed") {
    operation = verifyAddResult(operation, await dependencies.readSnapshot());
    update(operation);
  } else {
    dependencies.onUpdate?.(operation);
  }
  return operation;
}

export function applyLiquidityReceipt(
  config: AppConfig,
  operations: readonly LiquidityOperation[],
  receipt: TransactionReceipt,
): LiquidityOperation[] {
  const byRequestId = new Map(
    operations.flatMap((operation) =>
      operation.requestId === null ? [] : [[operation.requestId, operation] as const]
    ),
  );
  const terminal = new Map<string, LiquidityOperation>();
  const record = (requestId: string, operation: LiquidityOperation) => {
    if (terminal.has(requestId)) {
      throw new Error("Queue receipt contains duplicate terminal liquidity events");
    }
    terminal.set(requestId, operation);
  };

  for (const event of MintEvent.allFromReceipt(receipt, {
    contractAddress: config.handlerAddress,
  })) {
    if (event.fields.request_id === null) continue;
    const requestId = toHex0x(event.fields.request_id);
    const operation = byRequestId.get(requestId);
    if (operation === undefined) continue;
    if (
      operation.kind !== "add"
      || toHex0x(event.topics.sender) !== operation.accountAddress
      || toHex0x(event.topics.recipient) !== operation.recipient
      || event.fields.amount_minted <= 0n
    ) throw new Error("Queue receipt contains invalid terminal mint evidence");
    record(requestId, {
      ...operation,
      status: "executed",
      terminalBlock: receipt.height.toString(),
      updatedAt: Date.now(),
      result: {
        transactionHash: toHex0x(receipt.txHash),
        blockHeight: receipt.height.toString(),
        liquidityMinted: event.fields.amount_minted.toString(),
        amountsDeposited: null,
        recipientVerified: true,
      },
    });
  }
  for (const event of BurnEvent.allFromReceipt(receipt, {
    contractAddress: config.handlerAddress,
  })) {
    if (event.fields.request_id === null) continue;
    const requestId = toHex0x(event.fields.request_id);
    const operation = byRequestId.get(requestId);
    if (operation === undefined) continue;
    if (
      operation.kind !== "remove"
      || toHex0x(event.topics.sender) !== operation.accountAddress
      || toHex0x(event.topics.recipient) !== operation.recipient
      || event.fields.amounts_redeemed.some((amount, index) =>
        amount < BigInt(operation.intent.amountsMin[index]!)
      )
    ) throw new Error("Queue receipt contains invalid terminal burn evidence");
    record(requestId, {
      ...operation,
      status: "executed",
      terminalBlock: receipt.height.toString(),
      updatedAt: Date.now(),
      result: {
        transactionHash: toHex0x(receipt.txHash),
        blockHeight: receipt.height.toString(),
        amountsRedeemed: [
          event.fields.amounts_redeemed[0].toString(),
          event.fields.amounts_redeemed[1].toString(),
        ],
      },
    });
  }
  for (const event of RequestFailed.allFromReceipt(receipt, {
    contractAddress: config.driverAddress,
  })) {
    const requestId = toHex0x(event.topics.request_id);
    const operation = byRequestId.get(requestId);
    if (operation === undefined) continue;
    record(requestId, {
      ...operation,
      status: "failed",
      terminalBlock: receipt.height.toString(),
      updatedAt: Date.now(),
    });
  }
  return operations.map((operation) =>
    operation.requestId === null ? operation : terminal.get(operation.requestId) ?? operation
  );
}

function targetForStep(
  config: AppConfig,
  operation: LiquidityOperation,
  snapshot: Awaited<ReturnType<SnapshotReader>>,
): Invocation | null {
  const name = firstRunnableStep(operation);
  if (name === null) return null;
  if (snapshot.feeTo !== null) throw new Error("Liquidity changes are disabled while protocol fees are enabled");
  const otherOperations = loadAccountLiquidityOperations(config)
    .filter(({ id }) => id !== operation.id);
  const requests = loadAccountRequestRecords(config);
  const creations = loadAccountCreationWorkflows(config);
  if (operation.kind === "add") {
    const desired = operation.intent.amountsDesired.map(BigInt) as unknown as readonly [bigint, bigint];
    const minimums = operation.intent.amountsMin.map(BigInt) as unknown as readonly [bigint, bigint];
    assertAddStillValid(snapshot, desired, minimums);
    const tokens = [snapshot.tokenA, snapshot.tokenB] as const;
    const balanceReserved = tokens.map((token) => {
      const tokenHex = toHex0x(token.address);
      return reservedInputForToken(requests, tokenHex)
        + reservedCreationToken(creations, tokenHex)
        + reservedLiquidityTokenAmount(otherOperations, tokenHex);
    });
    if (tokens.some((token, index) =>
      token.balance < desired[index]! + balanceReserved[index]!
    )) throw new Error("The unreserved token balance is insufficient");
    const allowanceReserved = tokens.map((token) =>
      requiredAllowanceFor({
        requests,
        liquidityOperations: otherOperations,
        creationWorkflows: creations,
      }, toHex0x(token.address), toHex0x(config.handlerAddress))
    );
    if (name === "approveToken0" || name === "approveToken1") {
      const index = name === "approveToken0" ? 0 : 1;
      const token = tokens[index];
      const required = desired[index]! + allowanceReserved[index]!;
      return token.allowance >= required
        ? null
        : buildApprovalTarget(token.address, config.handlerAddress, required - token.allowance);
    }
    if (name === "enqueue") {
      if (
        snapshot.tokenA.allowance < desired[0] + allowanceReserved[0]!
        || snapshot.tokenB.allowance < desired[1] + allowanceReserved[1]!
      ) throw new Error("The liquidity allowances have not been observed yet");
      return buildAddLiquidityTarget(config.routerAddress, {
        token0: config.tokenAAddress,
        token1: config.tokenBAddress,
        amountsDesired: desired,
        amountsMin: minimums,
        recipient: config.accountAddress,
      });
    }
  } else {
    const liquidity = BigInt(operation.intent.liquidity);
    const liquidityHex = toHex0x(config.liquidityTokenAddress);
    const balanceReserved = reservedLiquidityTokenAmount(otherOperations, liquidityHex)
      + reservedInputForToken(requests, liquidityHex)
      + reservedCreationToken(creations, liquidityHex);
    if (snapshot.liquidityBalance < liquidity + balanceReserved) {
      throw new Error("The unreserved LP balance is insufficient");
    }
    const allowanceReserved = requiredAllowanceFor({
      requests,
      liquidityOperations: otherOperations,
      creationWorkflows: creations,
    }, liquidityHex, toHex0x(config.handlerAddress));
    if (name === "approveLiquidity") {
      const required = liquidity + allowanceReserved;
      return snapshot.liquidityAllowance >= required
        ? null
        : buildApprovalTarget(
            config.liquidityTokenAddress,
            config.handlerAddress,
            required - snapshot.liquidityAllowance,
          );
    }
    if (name === "enqueue") {
      if (snapshot.liquidityAllowance < liquidity + allowanceReserved) {
        throw new Error("The LP allowance has not been observed yet");
      }
      return buildRemoveLiquidityTarget(config.routerAddress, {
        token0: config.tokenAAddress,
        token1: config.tokenBAddress,
        liquidity,
        amountsMin: operation.intent.amountsMin.map(BigInt) as unknown as readonly [bigint, bigint],
        recipient: config.accountAddress,
      });
    }
  }
  return null;
}

function assertAccountCanSign(
  config: AppConfig,
  operation: LiquidityOperation,
  step: LiquidityStepName,
): void {
  if (hasBlockingAllowanceCleanup(config)) {
    throw new Error("Resolve the account's pending allowance cleanup first");
  }
  if (loadAccountCrankAttempts(config).some(isBlockingCrankAttempt)) {
    throw new Error("Resolve the account's indeterminate queue-processing transaction first");
  }
  if (loadAccountRequestRecords(config).some((request) =>
    request.status === "approving"
    || request.status === "submitting"
    || request.status === "indeterminate"
  )) throw new Error("Resolve the account's pending transaction first");
  if (loadAccountCreationWorkflows(config).some(hasBlockingCreationTransaction)) {
    throw new Error("Resolve the account's pending pool creation first");
  }
  if (loadAccountLiquidityOperations(config).some((candidate) =>
    candidate.id !== operation.id && hasBlockingLiquidityTransaction(candidate)
  )) throw new Error("Resolve the account's other pending liquidity transaction first");
  if (step === "enqueue") {
    const exposed = loadAccountRequestRecords(config).filter(hasExecutionExposure).length
      + loadAccountCreationWorkflows(config).filter(hasCreationExecutionExposure).length
      + loadAccountLiquidityOperations(config)
        .filter((candidate) => candidate.id !== operation.id)
        .filter(hasLiquidityExecutionExposure).length;
    if (exposed >= MAX_EXECUTION_EXPOSURE) {
      throw new Error("The account already has ten execution-exposed operations");
    }
  }
}

function applyCommittedRouterStep(
  config: AppConfig,
  operation: LiquidityOperation,
  name: LiquidityStepName,
  receipt: TransactionReceipt,
  update: (operation: LiquidityOperation) => LiquidityOperation,
): LiquidityOperation {
  let next = updateStep(operation, name, {
    status: "committed",
    transactionHash: toHex0x(receipt.txHash),
    message: null,
  });
  if (name === "enqueue") {
    const accepted = RequestAccepted.allFromReceipt(receipt, {
      contractAddress: config.driverAddress,
    });
    if (accepted.length !== 1) {
      throw new Error("Router receipt does not contain one matching RequestAccepted event");
    }
    next = {
      ...next,
      status: "queued",
      requestId: toHex0x(accepted[0]!.topics.request_id),
      receiptBlock: receipt.height.toString(),
      updatedAt: Date.now(),
    };
  }
  return update(next);
}

function applyWriteResult(
  operation: LiquidityOperation,
  name: LiquidityStepName,
  result: WriteResult,
  update: (operation: LiquidityOperation) => LiquidityOperation,
): LiquidityOperation {
  if (result.kind === "committedSuccess") return operation;
  if (result.kind === "indeterminate") {
    return update(updateStep(operation, name, {
      status: "indeterminate",
      transactionHash: result.hash ?? operation.steps[name].transactionHash,
      message: "The transaction outcome is uncertain.",
    }));
  }
  return update(updateStep(operation, name, {
    status: "failed",
    transactionHash: result.hash,
    message: writeFailureMessage(operation, name, result),
  }));
}

function verifyAddResult(
  operation: AddLiquidityOperation,
  snapshot: Awaited<ReturnType<SnapshotReader>>,
): AddLiquidityOperation {
  if (operation.result === null) return operation;
  const minted = BigInt(operation.result.liquidityMinted);
  const beforeLiquidity = BigInt(operation.intent.liquidityBalanceBefore);
  return {
    ...operation,
    result: {
      ...operation.result,
      recipientVerified: snapshot.liquidityBalance === beforeLiquidity + minted,
      amountsDeposited: null,
    },
    updatedAt: Date.now(),
  };
}

function assertAddStillValid(
  snapshot: Awaited<ReturnType<SnapshotReader>>,
  desired: readonly [bigint, bigint],
  minimums: readonly [bigint, bigint],
): void {
  if (
    snapshot.reserve0 <= 0n
    || snapshot.reserve1 <= 0n
    || snapshot.liquidityTotalSupply <= 0n
  ) throw new Error("The pool no longer has usable liquidity");
  const optimal1 = desired[0] * snapshot.reserve1 / snapshot.reserve0;
  const actual = optimal1 <= desired[1]
    ? [desired[0], optimal1] as const
    : [desired[1] * snapshot.reserve0 / snapshot.reserve1, desired[1]] as const;
  if (actual[0] < minimums[0] || actual[1] < minimums[1]) {
    throw new Error("The live pool ratio moved beyond the reviewed deposit minimums");
  }
}

function authoritativeOperation(
  config: AppConfig,
  initial: LiquidityOperation,
): LiquidityOperation {
  const stored = loadLiquidityOperations(config).find(({ id }) => id === initial.id);
  if (stored === undefined) throw new Error("The liquidity operation changed before locking");
  return stored;
}

function firstRunnableStep(operation: LiquidityOperation): LiquidityStepName | null {
  const order: readonly LiquidityStepName[] = operation.kind === "add"
    ? ["approveToken0", "approveToken1", "enqueue"]
    : ["approveLiquidity", "enqueue"];
  return order.find((name) => {
    const status = operation.steps[name].status;
    return status !== "committed" && status !== "skipped";
  }) ?? null;
}

function updateStep(
  operation: LiquidityOperation,
  name: LiquidityStepName,
  patch: Partial<Omit<LiquidityOperation["steps"][LiquidityStepName], "updatedAt">>,
): LiquidityOperation {
  const now = Date.now();
  return {
    ...operation,
    updatedAt: now,
    steps: {
      ...operation.steps,
      [name]: { ...operation.steps[name], ...patch, updatedAt: now },
    },
  };
}

function writeFailureMessage(
  operation: LiquidityOperation,
  name: LiquidityStepName,
  result: Exclude<WriteResult, { kind: "committedSuccess" | "indeterminate" }>,
): string {
  if (result.kind === "preSubmissionFailure") return result.message;
  if (result.kind === "invalid") return result.reason;
  return liquidityFailureMessage(operation, name, result.receipt)
    ?? "The transaction committed with a failed execution result";
}

function crankFailureMessage(
  result: Exclude<WriteResult, { kind: "committedSuccess" | "indeterminate" }>,
): string {
  if (result.kind === "preSubmissionFailure") return result.message;
  if (result.kind === "invalid") return result.reason;
  return swapFailureMessage("crank", result.receipt)
    ?? "The queue-processing transaction committed without succeeding";
}
