import { addressFromHex, bytesEqual, toHex0x, type TransactionReceipt } from "@groundhogchain/client";
import type { Invocation } from "@groundhogchain/protocol";

import type { AppConfig, GlobalConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import {
  buildProcessRequestsTarget,
  decodeRequestsProcessedSummary,
} from "@/contracts/driver-target";
import { createSwapFactoryReadAdapter, type PoolAddresses } from "@/contracts/factory-adapter";
import { buildCreatePairTarget } from "@/contracts/factory-target";
import { creationFailureMessage } from "@/contracts/failure-message";
import { RequestAccepted } from "@/contracts/generated/swap-driver";
import { PoolCreated } from "@/contracts/generated/swap-factory";
import { buildAddLiquidityTarget } from "@/contracts/router-target";
import { requiredAllowanceFor } from "@/domain/allowance-exposure";
import { formatAmount } from "@/domain/amount";
import { reservedInputForToken } from "@/domain/reservations";
import { createReadClient, NetworkMismatchError, verifyReadNetwork } from "@/groundhog/client";
import {
  PoolCreationNetworkError,
  PoolCreationValidationError,
  preparePoolCreation,
  type PoolCreationDependencies,
  type PoolCreationReview,
} from "@/pools/pool-creation";
import { hasBlockingAllowanceCleanup } from "@/transactions/allowance-cleanup";
import {
  applyCreationReceipt,
  createCreationObserver,
} from "@/transactions/creation-observer";
import {
  creationStepOrder,
  hasBlockingCreationTransaction,
  hasCreationFundingExposure,
  hasCreationExecutionExposure,
  loadAccountCreationWorkflows,
  loadCreationWorkflow,
  reservedCreationHog,
  reservedCreationToken,
  saveCreationWorkflow,
  sameCreationIntent,
  type CreationPool,
  type CreationStepName,
  type CreationWorkflow,
} from "@/transactions/creation-workflow";
import { isBlockingCrankAttempt, loadAccountCrankAttempts } from "@/transactions/crank-attempt";
import {
  applyLiquidityReceipt,
} from "@/transactions/liquidity-executor";
import {
  hasBlockingLiquidityTransaction,
  hasLiquidityExecutionExposure,
  loadAccountLiquidityOperations,
  loadLiquidityOperations,
  reservedLiquidityTokenAmount,
  saveLiquidityOperations,
} from "@/transactions/liquidity-operation";
import {
  applyObservationBatch,
  observationsFromReceipt,
} from "@/transactions/request-observer";
import {
  hasExecutionExposure,
  loadAccountRequestRecords,
  loadRequestCollectionForUpdate,
  needsQueueProcessing,
  saveRequestCollection,
} from "@/transactions/request-collection";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";

const MAX_EXECUTION_EXPOSURE = 10;

export interface CreationExecutorDependencies extends PoolCreationDependencies {
  writeBoundary: WriteBoundary;
  automaticProcessing?: boolean;
  observeQueued?: (workflow: CreationWorkflow) => Promise<CreationWorkflow>;
  onUpdate?: (workflow: CreationWorkflow) => void;
  assertCurrent?: () => void;
}

export class CreationRecoveryRequiredError extends Error {
  constructor(public readonly step: CreationStepName) {
    super("Confirm that the pre-hash transaction was never signed before retrying");
    this.name = "CreationRecoveryRequiredError";
  }
}

export async function runCreationWorkflow(
  config: GlobalConfig,
  initial: CreationWorkflow,
  dependencies: CreationExecutorDependencies,
): Promise<CreationWorkflow> {
  dependencies.assertCurrent?.();
  const persisted = loadCreationWorkflow(config, initial.token0.address, initial.token1.address);
  if (persisted === null || persisted.id !== initial.id) {
    throw new Error("The pool-creation workflow changed before the account lock was acquired");
  }
  if (!sameCreationIntent(persisted, initial)) {
    throw new Error("The saved creation intent changed; review it before continuing");
  }
  let workflow = persisted;
  const update = (next: CreationWorkflow): CreationWorkflow => {
    workflow = saveCreationWorkflow(config, next);
    dependencies.onUpdate?.(workflow);
    return workflow;
  };

  if (workflow.status === "queued") {
    await verifyReadNetwork(dependencies.client ?? createReadClient(config), config);
    const observed = await (
      dependencies.observeQueued
      ?? createCreationObserver(config).scan
    )(workflow);
    await verifyReadNetwork(dependencies.client ?? createReadClient(config), config);
    if (observed !== workflow) workflow = update(observed);
    if (workflow.status === "executed" || workflow.status === "failed") {
      return workflow;
    }
  }

  for (const name of creationStepOrder) {
    if (["executed", "failed", "race", "archived"].includes(workflow.status)) break;
    if (name === "crank" && workflow.status === "queued" && dependencies.automaticProcessing === false) {
      return workflow;
    }
    const step = workflow.steps[name];
    if (step.status === "committed" || step.status === "skipped") continue;

    if (step.status === "signing" || step.status === "indeterminate") {
      if (step.transactionHash === null) throw new CreationRecoveryRequiredError(name);
      if (dependencies.writeBoundary.observe === undefined) {
        throw new Error("This wallet cannot recover the stored transaction");
      }
      await verifyReadNetwork(dependencies.client ?? createReadClient(config), config);
      const observed = await dependencies.writeBoundary.observe(step.transactionHash);
      await verifyReadNetwork(dependencies.client ?? createReadClient(config), config);
      workflow = applyWriteResult(workflow, name, observed, update);
      if (observed.kind !== "committedSuccess") {
        if (name === "createPool" && observed.kind !== "indeterminate") {
          workflow = await markRaceIfPoolExists(config, workflow, name, dependencies, update);
        }
        return workflow;
      }
      workflow = await applyCommittedStep(
        config,
        workflow,
        name,
        observed.receipt,
        dependencies,
        update,
      );
      continue;
    }

    let review: PoolCreationReview | null = null;
    if (name !== "crank") {
      try {
        review = await revalidateWorkflow(config, workflow, dependencies);
      } catch (error) {
        if (error instanceof NetworkMismatchError || error instanceof PoolCreationNetworkError) throw error;
        if (error instanceof PoolCreationValidationError && error.code === "poolExists") {
          return markRace(config, workflow, name, dependencies, update);
        }
        if (
          name === "createPool"
          && workflow.steps.approveFunding.status === "committed"
        ) {
          const next = updateStep(workflow, name, {
            status: "failed",
            transactionHash: null,
            receiptBlock: null,
            message: error instanceof Error
              ? error.message
              : "Pool creation could not be revalidated",
          });
          return update({ ...next, status: "failed", updatedAt: Date.now() });
        }
        throw error;
      }
    }
    await verifyReadNetwork(dependencies.client ?? createReadClient(config), config);
    assertAccountCanSign(config, workflow, name);
    dependencies.assertCurrent?.();
    const target = targetForStep(config, workflow, review, name);
    if (target === null) {
      workflow = update(updateStep(workflow, name, {
        status: "skipped",
        transactionHash: null,
        message: null,
      }));
      continue;
    }

    workflow = update(updateStep(workflow, name, {
      status: "signing",
      transactionHash: null,
      message: null,
    }));
    const result = await dependencies.writeBoundary.execute(target, {
      onSigned: (transactionHash) => {
        workflow = update(updateStep(workflow, name, { transactionHash }));
      },
    });
    await verifyReadNetwork(dependencies.client ?? createReadClient(config), config);
    workflow = applyWriteResult(workflow, name, result, update);
    if (result.kind !== "committedSuccess") {
      if (name === "createPool" && result.kind !== "indeterminate") {
        workflow = await markRaceIfPoolExists(config, workflow, name, dependencies, update);
      }
      return workflow;
    }
    workflow = await applyCommittedStep(
      config,
      workflow,
      name,
      result.receipt,
      dependencies,
      update,
    );
  }
  return workflow;
}

export function confirmCreationStepWasNotSigned(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  expectedStep: CreationStepName,
): CreationWorkflow {
  const step = workflow.steps[expectedStep];
  if ((step.status !== "signing" && step.status !== "indeterminate") || step.transactionHash !== null) {
    throw new Error("The creation workflow advanced in another tab; review its current step");
  }
  return saveCreationWorkflow(config, updateStep(workflow, expectedStep, {
    status: "pending",
    transactionHash: null,
    receiptBlock: null,
    message: "Confirmed locally as not signed",
  }));
}

export function resetCreationCrank(
  config: GlobalConfig,
  workflow: CreationWorkflow,
): CreationWorkflow {
  if (workflow.status !== "queued") return workflow;
  const step = workflow.steps.crank;
  if (step.status !== "committed" && step.status !== "failed") return workflow;
  return saveCreationWorkflow(config, updateStep(workflow, "crank", {
    status: "pending",
    transactionHash: null,
    message: null,
  }));
}

export function continueSupersededCreation(
  config: GlobalConfig,
  workflow: CreationWorkflow,
): CreationWorkflow {
  if (workflow.status !== "race" || workflow.pool === null || workflow.requestId !== null) {
    throw new Error("This creation workflow is not waiting for liquidity continuation");
  }
  const funding = workflow.steps.approveFunding.status === "committed"
    ? workflow
    : updateStep(workflow, "approveFunding", {
      status: "skipped",
      transactionHash: null,
      receiptBlock: null,
      message: "The existing pool does not require factory funding.",
    });
  const next = updateStep(funding, "createPool", {
    status: "skipped",
    transactionHash: null,
    receiptBlock: null,
    message: "Using the pool created by another account.",
  });
  return saveCreationWorkflow(config, {
    ...next,
    status: "active",
    updatedAt: Date.now(),
  });
}

async function revalidateWorkflow(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  dependencies: PoolCreationDependencies,
): Promise<PoolCreationReview> {
  const otherWorkflows = loadAccountCreationWorkflows(config).filter(({ id }) => id !== workflow.id);
  const requests = loadAccountRequestRecords(config);
  const liquidityOperations = loadAccountLiquidityOperations(config);
  const nativeHogHex = toHex0x(config.nativeHogAddress);
  const review = await preparePoolCreation(
    config,
    {
      tokenA: workflow.token0.address,
      tokenB: workflow.token1.address,
      amountA: formatAmount(BigInt(workflow.token0.amount), workflow.token0.decimals),
      amountB: formatAmount(BigInt(workflow.token1.amount), workflow.token1.decimals),
    },
    reservedCreationHog(otherWorkflows)
      + reservedCreationToken(otherWorkflows, nativeHogHex)
      + reservedInputForToken(requests, nativeHogHex)
      + reservedLiquidityTokenAmount(liquidityOperations, nativeHogHex),
    {
      ...dependencies,
      requiredNativeHog: hasCreationFundingExposure(workflow)
        ? BigInt(workflow.totalFunding)
        : 0n,
      ...(workflow.pool === null ? {} : { existingPool: poolAddresses(workflow.pool) }),
    },
  );
  if (
    review.token0.addressHex !== workflow.token0.address
    || review.token1.addressHex !== workflow.token1.address
    || review.token0.amount !== BigInt(workflow.token0.amount)
    || review.token1.amount !== BigInt(workflow.token1.amount)
    || review.fundingMinimum !== BigInt(workflow.fundingMinimum)
    || review.fundingPerContract !== BigInt(workflow.fundingPerContract)
    || review.totalFunding !== BigInt(workflow.totalFunding)
  ) throw new Error("The creation review no longer matches the saved workflow");

  for (const token of [review.token0, review.token1]) {
    const reserved = reservedCreationToken(otherWorkflows, token.addressHex)
      + reservedInputForToken(requests, token.addressHex)
      + reservedLiquidityTokenAmount(liquidityOperations, token.addressHex);
    if (token.balance < token.amount + reserved) {
      throw new Error(`The unreserved ${token.symbol} balance is no longer sufficient`);
    }
  }
  if (review.pool === null) return review;
  const records = { requests, liquidityOperations, creationWorkflows: otherWorkflows };
  return {
    ...review,
    token0: withAggregateApproval(review.token0, records, workflow.pool!.handler),
    token1: withAggregateApproval(review.token1, records, workflow.pool!.handler),
  };
}

function assertAccountCanSign(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  step: CreationStepName,
): void {
  if (hasBlockingAllowanceCleanup(config)) {
    throw new Error("Resolve the account's pending allowance cleanup first");
  }
  if (loadAccountCrankAttempts(config).some(isBlockingCrankAttempt)) {
    throw new Error("Resolve the account's indeterminate queue-processing transaction first");
  }
  if (loadAccountRequestRecords(config).some((request) =>
    request.status === "approving" || request.status === "submitting" || request.status === "indeterminate"
  )) throw new Error("Resolve the account's pending transaction first");
  const liquidityOperations = loadAccountLiquidityOperations(config);
  if (liquidityOperations.some(hasBlockingLiquidityTransaction)) {
    throw new Error("Resolve the account's pending liquidity transaction first");
  }
  if (loadAccountCreationWorkflows(config).some((candidate) =>
    candidate.id !== workflow.id && hasBlockingCreationTransaction(candidate)
  )) throw new Error("Resolve the account's other pool-creation transaction first");
  if (step === "enqueue") {
    const exposed = loadAccountRequestRecords(config).filter(hasExecutionExposure).length
      + loadAccountCreationWorkflows(config).filter(hasCreationExecutionExposure).length
      + liquidityOperations.filter(hasLiquidityExecutionExposure).length;
    if (exposed >= MAX_EXECUTION_EXPOSURE) {
      throw new Error("The account already has ten execution-exposed operations");
    }
  }
}

function withAggregateApproval(
  token: PoolCreationReview["token0"],
  records: Parameters<typeof requiredAllowanceFor>[0],
  handlerAddress: string,
): PoolCreationReview["token0"] {
  const required = token.amount + requiredAllowanceFor(records, token.addressHex, handlerAddress);
  return {
    ...token,
    approvalDifference: token.allowance >= required ? 0n : required - token.allowance,
  };
}

function targetForStep(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  review: PoolCreationReview | null,
  name: CreationStepName,
): Invocation | null {
  if (name === "approveFunding") {
    if (review === null) throw new Error("Creation review is unavailable");
    return review.fundingApprovalDifference === 0n
      ? null
      : buildApprovalTarget(config.nativeHogAddress, config.factoryAddress, review.fundingApprovalDifference);
  }
  if (name === "createPool") {
    return buildCreatePairTarget(
      config.factoryAddress,
      addressFromHex(workflow.token0.address),
      addressFromHex(workflow.token1.address),
      BigInt(workflow.fundingPerContract),
    );
  }
  if (name === "approveToken0" || name === "approveToken1") {
    if (review?.pool === null || review === null) throw new Error("The created pool is unavailable");
    const token = name === "approveToken0" ? review.token0 : review.token1;
    return token.approvalDifference === 0n
      ? null
      : buildApprovalTarget(token.address, review.pool.handler, token.approvalDifference);
  }
  if (name === "enqueue") {
    if (review?.pool === null || review === null) throw new Error("The created pool is unavailable");
    if (review.token0.approvalDifference !== 0n || review.token1.approvalDifference !== 0n) {
      throw new Error("The reviewed token allowances have not been observed yet");
    }
    return buildAddLiquidityTarget(config.routerAddress, {
      token0: review.token0.address,
      token1: review.token1.address,
      amountsDesired: [review.token0.amount, review.token1.amount],
      amountsMin: [review.token0.amount, review.token1.amount],
      recipient: config.accountAddress,
    });
  }
  if (workflow.pool === null) throw new Error("The created pool is unavailable");
  return buildProcessRequestsTarget(addressFromHex(workflow.pool.driver));
}

function applyWriteResult(
  workflow: CreationWorkflow,
  name: CreationStepName,
  result: WriteResult,
  update: (workflow: CreationWorkflow) => CreationWorkflow,
): CreationWorkflow {
  if (result.kind === "committedSuccess") return workflow;
  if (result.kind === "indeterminate") {
    return update(updateStep(workflow, name, {
      status: "indeterminate",
      transactionHash: result.hash ?? workflow.steps[name].transactionHash,
      message: "The transaction outcome is uncertain. Check it before continuing.",
    }));
  }
  const message = result.kind === "preSubmissionFailure"
    ? result.message
    : result.kind === "invalid"
      ? result.reason
      : creationFailureMessage(name, result.receipt)
        ?? "The transaction committed with a failed execution result";
  const next = updateStep(workflow, name, {
    status: "failed",
    transactionHash: result.hash,
    message,
  });
  return update(name === "createPool"
    ? { ...next, status: "failed", updatedAt: Date.now() }
    : next);
}

async function applyCommittedStep(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  name: CreationStepName,
  receipt: TransactionReceipt,
  dependencies: PoolCreationDependencies,
  update: (workflow: CreationWorkflow) => CreationWorkflow,
): Promise<CreationWorkflow> {
  let next = updateStep(workflow, name, {
    status: "committed",
    transactionHash: toHex0x(receipt.txHash),
    receiptBlock: receipt.height.toString(),
    message: null,
  });
  if (name === "createPool") {
    let created: ReturnType<typeof PoolCreated.allFromReceipt> = [];
    try {
      created = PoolCreated.allFromReceipt(receipt, {
        contractAddress: config.factoryAddress,
      }).filter((event) =>
        toHex0x(event.topics.token0) === workflow.token0.address
        && toHex0x(event.topics.token1) === workflow.token1.address
      );
    } catch {
      // Factory state remains authoritative when receipt event decoding is unavailable.
    }
    if (created.length === 1) {
      const event = created[0]!;
      next = {
        ...next,
        pool: {
          liquidityToken: toHex0x(event.fields.liquidity_token),
          handler: toHex0x(event.fields.handler),
          driver: toHex0x(event.fields.driver),
        },
      };
    } else {
      try {
        next = {
          ...next,
          pool: await resolveExistingPool(config, workflow, dependencies),
        };
      } catch {
        return update(updateStep(workflow, name, {
          status: "indeterminate",
          transactionHash: toHex0x(receipt.txHash),
          receiptBlock: null,
          message: "Pool creation committed, but its factory record could not be resolved yet.",
        }));
      }
    }
    if (created.length === 1) {
      const eventPool = next.pool!;
      try {
        const resolved = await resolveExistingPool(config, workflow, dependencies);
        if (
          resolved.liquidityToken !== eventPool.liquidityToken
          || resolved.handler !== eventPool.handler
          || resolved.driver !== eventPool.driver
        ) throw new Error("factory mismatch");
      } catch {
        return update(updateStep(workflow, name, {
          status: "indeterminate",
          transactionHash: toHex0x(receipt.txHash),
          receiptBlock: null,
          message: "Pool creation committed, but its receipt does not match factory state yet.",
        }));
      }
    }
  }
  if (name === "enqueue") {
    if (next.pool === null) throw new Error("The created pool is unavailable");
    const accepted = RequestAccepted.allFromReceipt(receipt, {
      contractAddress: addressFromHex(next.pool.driver),
    });
    if (accepted.length !== 1) {
      return update({
        ...next,
        status: "failed",
        updatedAt: Date.now(),
        steps: {
          ...next.steps,
          enqueue: {
            ...next.steps.enqueue,
            message: "Liquidity submission did not emit one RequestAccepted event.",
          },
        },
      });
    }
    next = {
      ...next,
      status: "queued",
      requestId: toHex0x(accepted[0]!.topics.request_id),
      enqueueReceiptBlock: receipt.height.toString(),
      updatedAt: Date.now(),
    };
  }
  if (name === "crank") {
    reconcileRelatedReceipt(config, next, receipt);
    next = applyCreationReceipt(next, receipt);
    if (next.status === "queued") {
      next = updateStep(next, "crank", {
        message: "The queue-processing transaction committed without this request's terminal event.",
      });
    }
  }
  return update(next);
}

function reconcileRelatedReceipt(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  receipt: TransactionReceipt,
): void {
  const poolConfig = workflowAppConfig(config, workflow);
  decodeRequestsProcessedSummary(receipt, poolConfig.driverAddress);
  const requests = loadRequestCollectionForUpdate(poolConfig);
  const queued = requests.filter((request) =>
    needsQueueProcessing(request)
    && request.requestId !== null
    && request.criteria.driverAddress === toHex0x(poolConfig.driverAddress)
  );
  if (queued.length > 0) {
    saveRequestCollection(
      poolConfig,
      applyObservationBatch(
        requests,
        queued,
        observationsFromReceipt(poolConfig, queued, receipt),
      ),
    );
  }
  const liquidity = loadLiquidityOperations(poolConfig);
  saveLiquidityOperations(
    poolConfig,
    applyLiquidityReceipt(poolConfig, liquidity, receipt),
  );
  for (const candidate of loadAccountCreationWorkflows(config)) {
    if (candidate.id === workflow.id) continue;
    const observed = applyCreationReceipt(candidate, receipt);
    if (observed !== candidate) saveCreationWorkflow(config, observed);
  }
}

async function markRace(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  step: CreationStepName,
  dependencies: PoolCreationDependencies,
  update: (workflow: CreationWorkflow) => CreationWorkflow,
): Promise<CreationWorkflow> {
  const pool = await resolveExistingPool(config, workflow, dependencies);
  const next = updateStep(workflow, step, {
    status: "failed",
    message: workflow.steps.approveFunding.status === "committed"
      ? "Another account created this pool. The unused factory allowance should be removed before continuing."
      : "Another account created this pool before a funding approval was submitted.",
  });
  return update({ ...next, pool, status: "race", updatedAt: Date.now() });
}

async function markRaceIfPoolExists(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  step: CreationStepName,
  dependencies: PoolCreationDependencies,
  update: (workflow: CreationWorkflow) => CreationWorkflow,
): Promise<CreationWorkflow> {
  try {
    return await markRace(config, workflow, step, dependencies, update);
  } catch {
    return workflow;
  }
}

async function resolveExistingPool(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  dependencies: PoolCreationDependencies,
): Promise<CreationPool> {
  const factory = dependencies.factory ?? createSwapFactoryReadAdapter({
    client: createReadClient(config),
    contract: config.factoryAddress,
    caller: config.accountAddress,
  });
  const token0 = addressFromHex(workflow.token0.address);
  const token1 = addressFromHex(workflow.token1.address);
  const [registered, addresses] = await Promise.all([
    factory.getPair(token0, token1),
    factory.poolAddresses(token0, token1),
  ]);
  if (
    registered.value === null
    || registered.height !== addresses.height
    || !bytesEqual(registered.value, addresses.value.handler)
  ) throw new Error("The existing pool could not be resolved consistently");
  return {
    liquidityToken: toHex0x(addresses.value.liquidityToken),
    handler: toHex0x(addresses.value.handler),
    driver: toHex0x(addresses.value.driver),
  };
}

function updateStep(
  workflow: CreationWorkflow,
  name: CreationStepName,
  patch: Partial<Omit<CreationWorkflow["steps"][CreationStepName], "updatedAt">>,
): CreationWorkflow {
  const now = Date.now();
  return {
    ...workflow,
    updatedAt: now,
    steps: {
      ...workflow.steps,
      [name]: { ...workflow.steps[name], ...patch, updatedAt: now },
    },
  };
}

function poolAddresses(pool: CreationPool): PoolAddresses {
  return {
    liquidityToken: addressFromHex(pool.liquidityToken),
    handler: addressFromHex(pool.handler),
    driver: addressFromHex(pool.driver),
  };
}

function workflowAppConfig(config: GlobalConfig, workflow: CreationWorkflow): AppConfig {
  if (workflow.pool === null) throw new Error("The created pool is unavailable");
  return {
    ...config,
    liquidityTokenAddress: addressFromHex(workflow.pool.liquidityToken),
    handlerAddress: addressFromHex(workflow.pool.handler),
    driverAddress: addressFromHex(workflow.pool.driver),
    tokenAAddress: addressFromHex(workflow.token0.address),
    tokenBAddress: addressFromHex(workflow.token1.address),
    tokenASymbol: workflow.token0.symbol,
    tokenBSymbol: workflow.token1.symbol,
    tokenADecimals: workflow.token0.decimals,
    tokenBDecimals: workflow.token1.decimals,
  };
}
