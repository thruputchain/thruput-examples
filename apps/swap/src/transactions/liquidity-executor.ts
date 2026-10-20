import { toBase58, toHex0x, type TransactionReceipt } from "@thruputchain/client";
import type { Invocation } from "@thruputchain/protocol";
import { DefaultWallet } from "@thruputchain/client/contracts";

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
import { batch_driver } from "@/contracts/generated/swap-driver";
import { swap_if } from "@/contracts/generated/swap-handler";
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
  needsQueueProcessing,
  saveRequestCollection,
} from "@/transactions/request-collection";
import {
  applyObservationBatch,
  observationsFromReceipt,
} from "@/transactions/request-observer";
import type { SnapshotReader } from "@/swap/snapshot";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";

const RequestAccepted = batch_driver.v0_1.events.RequestAccepted;
const { LiquidityBurnEvent: BurnEvent, LiquidityMintEvent: MintEvent } =
  swap_if.v0_1.events;
type RequestAccepted = batch_driver.v0_1.events.RequestAccepted;
const RequestFailed = batch_driver.v0_1.events.RequestFailed;
type RequestFailed = batch_driver.v0_1.events.RequestFailed;

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

  if (operation.status === "active") {
    const fresh = operation.executionMode === "auto" && steps.every((name) =>
      operation.steps[name].status === "pending" && operation.steps[name].transactionHash === null);
    // Probe basic support before preparing a batch; its final size is checked
    // after unnecessary approvals have been omitted.
    if (operation.executionMode === "batch" || (fresh && dependencies.writeBoundary.executeBatch &&
      await dependencies.writeBoundary.supportsBatch?.(1))) {
      const batched = await runLiquidityBatch(config, operation, steps, dependencies, update);
      if (batched !== null) {
        operation = batched;
        if (operation.status !== "queued") return operation;
      }
    }
  }

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

    let snapshot = await dependencies.readSnapshot();
    const confirmedHeight = Object.values(operation.steps).reduce((height, entry) =>
      entry.status === "committed" && entry.receiptBlock !== undefined && BigInt(entry.receiptBlock) > height
        ? BigInt(entry.receiptBlock) : height, 0n);
    for (let attempt = 0; snapshot.chainHeight < confirmedHeight && attempt < 4; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      snapshot = await dependencies.readSnapshot();
    }
    if (snapshot.chainHeight < confirmedHeight)
      throw new Error("The pool snapshot has not reached the confirmed approval block yet. Check again.");
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
    operation = update(updateStep({ ...operation, ...(operation.executionMode === "auto" ? { executionMode: "single" as const } : {}) }, name, {
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
    && attempt.driverAddress !== toBase58(config.driverAddress)
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

async function runLiquidityBatch(
  config: AppConfig,
  initial: LiquidityOperation,
  order: readonly LiquidityStepName[],
  dependencies: LiquidityExecutorDependencies,
  update: (operation: LiquidityOperation) => LiquidityOperation,
): Promise<LiquidityOperation | null> {
  let operation = initial;
  const writer = dependencies.writeBoundary;
  const step = operation.steps.enqueue;
  let result: WriteResult;
  if (["signing", "indeterminate"].includes(step.status)) {
    if (step.transactionHash === null)
      throw new Error(
        "Confirm that the batch was never signed before retrying",
      );
    if (!writer.observe)
      throw new Error("This wallet cannot recover the stored batch");
    result = await writer.observe(step.transactionHash);
  } else {
    const snapshot = await dependencies.readSnapshot();
    assertAccountCanSign(config, operation, "enqueue");
    const calls: Invocation[] = [];
    const names: LiquidityStepName[] = [];
    for (const name of order) {
      const target = targetForStep(config, operation, snapshot, name, true);
      if (target) {
        calls.push(target);
        names.push(name);
      } else
        operation = updateStep(operation, name, {
          status: "skipped",
          transactionHash: null,
          message: null,
        });
    }
    if (!writer.executeBatch)
      throw new Error("Reconnect a wallet that supports this saved batch");
    if (operation.executionMode !== "batch" && !(await writer.supportsBatch?.(calls.length)))
      return null;
    operation = update(
      updateLiquidityBatch(
        { ...operation, executionMode: "batch", batchSteps: names },
        {
          status: "signing",
          transactionHash: null,
          message: "One wallet approval for this batch",
        },
      ),
    );
    result = await writer.executeBatch(calls, {
      onSigned(transactionHash) {
        operation = update(
          updateLiquidityBatch(operation, { transactionHash }),
        );
      },
    });
  }
  if (result.kind === "committedSuccess") {
    try {
      if (
        DefaultWallet.v0_1.execute.decodeReceipt(result.receipt).value.length !==
        operation.batchSteps!.length
      )
        throw new Error("Unexpected batch results");
      const accepted = RequestAccepted.allFromReceipt(result.receipt, {
        contractAddress: config.driverAddress,
      });
      if (accepted.length !== 1)
        throw new Error("Expected one liquidity request");
      return applyCommittedRouterStep(
        config,
        updateLiquidityBatch(operation, {
          status: "committed",
          transactionHash: result.hash,
          message: null,
        }),
        "enqueue",
        result.receipt,
        update,
      );
    } catch {
      return update(
        updateLiquidityBatch(operation, {
          status: "indeterminate",
          transactionHash: result.hash,
          message:
            "Batch committed; check its liquidity request evidence before continuing.",
        }),
      );
    }
  }
  return update(
    updateLiquidityBatch(operation, {
      status: result.kind === "indeterminate" ? "indeterminate" : "failed",
      transactionHash: result.hash,
      message:
        result.kind === "preSubmissionFailure"
          ? result.message
          : result.kind === "indeterminate"
            ? "The batch may still commit. Check its original transaction."
            : "Liquidity batch failed. All calls were rolled back.",
    }),
  );
}

function updateLiquidityBatch(
  operation: LiquidityOperation,
  patch: Partial<LiquidityOperation["steps"][LiquidityStepName]>,
): LiquidityOperation {
  const steps = { ...operation.steps };
  const updatedAt = Date.now();
  for (const name of operation.batchSteps ?? [])
    steps[name] = { ...steps[name], ...patch, updatedAt };
  return { ...operation, steps, updatedAt };
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
  const patch = {
    status: "pending" as const,
    transactionHash: null,
    message: "Confirmed locally as not signed",
  };
  const next = authoritative.executionMode === "batch"
    ? updateLiquidityBatch(authoritative, patch)
    : updateStep(authoritative, expectedStep, patch);
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
  const queuedRequests = requests.filter((request) =>
    needsQueueProcessing(request)
    && request.requestId !== null
    && request.criteria.driverAddress === toBase58(config.driverAddress)
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
      || toBase58(event.topics.sender) !== operation.accountAddress
      || toBase58(event.topics.recipient) !== operation.recipient
      || event.fields.amount_minted <= 0n
    ) throw new Error("Queue receipt contains invalid terminal mint evidence");
    record(requestId, {
      ...operation,
      status: "executed",
      terminalBlock: receipt.height.toString(),
      updatedAt: Date.now(),
      result: {
        transactionHash: toBase58(receipt.txHash),
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
      || toBase58(event.topics.sender) !== operation.accountAddress
      || toBase58(event.topics.recipient) !== operation.recipient
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
        transactionHash: toBase58(receipt.txHash),
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
  name: LiquidityStepName | null = firstRunnableStep(operation),
  approvalsIncluded = false,
): Invocation | null {
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
      const tokenBase58 = toBase58(token.address);
      return reservedInputForToken(requests, tokenBase58)
        + reservedCreationToken(creations, tokenBase58)
        + reservedLiquidityTokenAmount(otherOperations, tokenBase58);
    });
    if (tokens.some((token, index) =>
      token.balance < desired[index]! + balanceReserved[index]!
    )) throw new Error("The unreserved token balance is insufficient");
    const allowanceReserved = tokens.map((token) =>
      requiredAllowanceFor({
        requests,
        liquidityOperations: otherOperations,
        creationWorkflows: creations,
      }, toBase58(token.address), toBase58(config.handlerAddress))
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
      if (!approvalsIncluded && (
        snapshot.tokenA.allowance < desired[0] + allowanceReserved[0]!
        || snapshot.tokenB.allowance < desired[1] + allowanceReserved[1]!
      )) throw new Error("The liquidity allowances have not been observed yet");
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
    const liquidityBase58 = toBase58(config.liquidityTokenAddress);
    const balanceReserved = reservedLiquidityTokenAmount(otherOperations, liquidityBase58)
      + reservedInputForToken(requests, liquidityBase58)
      + reservedCreationToken(creations, liquidityBase58);
    if (snapshot.liquidityBalance < liquidity + balanceReserved) {
      throw new Error("The unreserved LP balance is insufficient");
    }
    const allowanceReserved = requiredAllowanceFor({
      requests,
      liquidityOperations: otherOperations,
      creationWorkflows: creations,
    }, liquidityBase58, toBase58(config.handlerAddress));
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
      if (!approvalsIncluded && snapshot.liquidityAllowance < liquidity + allowanceReserved) {
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
    transactionHash: toBase58(receipt.txHash),
    receiptBlock: receipt.height.toString(),
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
