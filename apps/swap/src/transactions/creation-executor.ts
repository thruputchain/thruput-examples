import { addressFromHex, toHex0x, type TransactionReceipt } from "@groundhogchain/client";
import type { ContractAddress, Invocation } from "@groundhogchain/protocol";

import type { AppConfig, GlobalConfig } from "@/config";
import { buildApprovalTarget } from "@/contracts/approval-target";
import { buildProcessRequestsTarget } from "@/contracts/driver-target";
import { PoolCreated } from "@/contracts/generated/swap-factory";
import { RequestAccepted, RequestFailed } from "@/contracts/generated/swap-driver";
import { MintEvent } from "@/contracts/generated/swap-pair";
import { buildAddLiquidityTarget } from "@/contracts/router-target";
import { buildTransferTarget } from "@/contracts/transfer-target";
import { formatAmount } from "@/domain/amount";
import { reservedInputForToken } from "@/domain/reservations";
import {
  PoolCreationValidationError,
  preparePoolCreation,
  type PoolCreationDependencies,
  type PoolCreationReview,
} from "@/pools/pool-creation";
import {
  creationStepOrder,
  hasBlockingCreationTransaction,
  hasCreationExecutionExposure,
  loadAccountCreationWorkflows,
  loadCreationWorkflow,
  reservedCreationHog,
  reservedCreationToken,
  saveCreationWorkflow,
  type CreationStepName,
  type CreationWorkflow,
} from "@/transactions/creation-workflow";
import { isBlockingCrankAttempt, loadAccountCrankAttempts } from "@/transactions/crank-attempt";
import {
  hasExecutionExposure,
  loadAccountRequestRecords,
} from "@/transactions/request-collection";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";
import {
  hasBlockingLiquidityTransaction,
  hasLiquidityExecutionExposure,
  loadAccountLiquidityOperations,
  reservedLiquidityTokenAmount,
} from "@/transactions/liquidity-operation";

const MAX_EXECUTION_EXPOSURE = 10;
const FUNDING_STEPS = [
  "fundLiquidityToken",
  "fundPair",
  "fundHandler",
  "fundDriver",
] as const satisfies readonly CreationStepName[];

export interface CreationExecutorDependencies extends PoolCreationDependencies {
  writeBoundary: WriteBoundary;
  automaticProcessing?: boolean;
  onUpdate?: (workflow: CreationWorkflow) => void;
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
  const persisted = loadCreationWorkflow(
    config,
    initial.token0.address,
    initial.token1.address,
  );
  if (persisted === null || persisted.id !== initial.id) {
    throw new Error("The pool-creation workflow changed before the account lock was acquired");
  }
  let workflow = persisted;
  const update = (next: CreationWorkflow): CreationWorkflow => {
    workflow = saveCreationWorkflow(config, next);
    dependencies.onUpdate?.(workflow);
    return workflow;
  };

  for (const name of creationStepOrder) {
    if (["executed", "failed", "race"].includes(workflow.status)) break;
    if (
      name === "crank"
      && workflow.status === "queued"
      && dependencies.automaticProcessing === false
    ) return workflow;
    let step = workflow.steps[name];
    if (step.status === "committed" || step.status === "skipped") continue;

    if (step.status === "signing" || step.status === "indeterminate") {
      if (step.transactionHash === null) {
        throw new CreationRecoveryRequiredError(name);
      }
      if (dependencies.writeBoundary.observe === undefined) {
        throw new Error("This wallet cannot recover the stored transaction");
      }
      const observed = await dependencies.writeBoundary.observe(step.transactionHash);
      workflow = applyWriteResult(workflow, name, observed, update);
      if (observed.kind !== "committedSuccess") return workflow;
      workflow = applyCommittedStep(config, workflow, name, observed.receipt, update);
      if (["failed", "race"].includes(workflow.status)) return workflow;
      step = workflow.steps[name];
      if (step.status !== "committed") return workflow;
      continue;
    }

    let review: PoolCreationReview | null = null;
    if (name !== "crank") {
      try {
        review = await revalidateWorkflow(config, workflow, dependencies);
      } catch (error) {
        if (error instanceof PoolCreationValidationError && error.code === "poolExists") {
          const raced = updateStep(workflow, name, {
            status: "failed",
            message:
              "This pool now exists. Committed prefunding remains at its canonical contracts; no additional transaction was signed.",
          });
          workflow = update({ ...raced, status: "race", updatedAt: Date.now() });
          return workflow;
        }
        throw error;
      }
    }
    assertAccountCanSign(config, workflow, name);
    const target = targetForStep(config, workflow, review, name);
    if (target === null) {
      workflow = updateStep(workflow, name, {
        status: "skipped",
        transactionHash: null,
        message: null,
      });
      workflow = update(workflow);
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
    workflow = applyWriteResult(workflow, name, result, update);
    if (result.kind !== "committedSuccess") return workflow;
    workflow = applyCommittedStep(config, workflow, name, result.receipt, update);
    if (["failed", "race"].includes(workflow.status)) return workflow;
  }
  return workflow;
}

export function confirmCreationStepWasNotSigned(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  expectedStep: CreationStepName,
): CreationWorkflow {
  const step = workflow.steps[expectedStep];
  if (
    (step.status !== "signing" && step.status !== "indeterminate")
    || step.transactionHash !== null
  ) {
    throw new Error("The creation workflow advanced in another tab; review its current step");
  }
  return saveCreationWorkflow(config, updateStep(workflow, expectedStep, {
    status: "pending",
    transactionHash: null,
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

async function revalidateWorkflow(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  dependencies: PoolCreationDependencies,
): Promise<PoolCreationReview> {
  const accountWorkflows = loadAccountCreationWorkflows(config);
  const otherWorkflows = accountWorkflows.filter(({ id }) => id !== workflow.id);
  const requests = loadAccountRequestRecords(config);
  const liquidityOperations = loadAccountLiquidityOperations(config);
  const nativeHogHex = toHex0x(config.nativeHogAddress);
  const remainingFunding = fundingSteps()
    .filter((name) => workflow.steps[name].status !== "committed").length;
  const review = await preparePoolCreation(
    config,
    {
      tokenA: workflow.token0.address,
      tokenB: workflow.token1.address,
      amountA: formatAmount(
        BigInt(workflow.token0.amount),
        workflow.token0.decimals,
      ),
      amountB: formatAmount(
        BigInt(workflow.token1.amount),
        workflow.token1.decimals,
      ),
    },
    reservedCreationHog(otherWorkflows)
      + reservedCreationToken(otherWorkflows, nativeHogHex)
      + reservedInputForToken(requests, nativeHogHex)
      + reservedLiquidityTokenAmount(liquidityOperations, nativeHogHex),
    {
      ...dependencies,
      requiredNativeHog:
        BigInt(workflow.fixedFundingPerContract) * BigInt(remainingFunding),
    },
  );
  assertReviewMatchesWorkflow(review, workflow);

  for (const token of [review.token0, review.token1]) {
    const otherCreationReservation = reservedCreationToken(
      otherWorkflows,
      token.addressHex,
    );
    const requestReservation = reservedInputForToken(requests, token.addressHex);
    const liquidityReservation = reservedLiquidityTokenAmount(
      liquidityOperations,
      token.addressHex,
    );
    if (
      token.balance < token.amount + otherCreationReservation
        + requestReservation + liquidityReservation
    ) {
      throw new Error(`The unreserved ${token.symbol} balance is no longer sufficient`);
    }
  }
  return review;
}

function assertAccountCanSign(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  step: CreationStepName,
): void {
  const scopedConfig = workflowAppConfig(config, workflow);
  if (loadAccountCrankAttempts(scopedConfig).some(isBlockingCrankAttempt)) {
    throw new Error("Resolve the account's indeterminate queue-processing transaction first");
  }
  const blockingRequest = loadAccountRequestRecords(scopedConfig).some((request) =>
    request.status === "approving"
    || request.status === "submitting"
    || request.status === "indeterminate"
  );
  if (blockingRequest) throw new Error("Resolve the account's pending transaction first");
  const liquidityOperations = loadAccountLiquidityOperations(config);
  if (liquidityOperations.some(hasBlockingLiquidityTransaction)) {
    throw new Error("Resolve the account's pending liquidity transaction first");
  }
  const otherBlockingCreation = loadAccountCreationWorkflows(config).some(
    (candidate) => candidate.id !== workflow.id && hasBlockingCreationTransaction(candidate),
  );
  if (otherBlockingCreation) {
    throw new Error("Resolve the account's other pool-creation transaction first");
  }
  if (step === "enqueue") {
    const exposed = loadAccountRequestRecords(scopedConfig)
        .filter(hasExecutionExposure).length
      + loadAccountCreationWorkflows(config).filter(hasCreationExecutionExposure).length
      + liquidityOperations.filter(hasLiquidityExecutionExposure).length;
    if (exposed >= MAX_EXECUTION_EXPOSURE) {
      throw new Error("The account already has ten execution-exposed operations");
    }
  }
}

function targetForStep(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  review: PoolCreationReview | null,
  name: CreationStepName,
): Invocation | null {
  if (fundingSteps().includes(name)) {
    if (review === null) throw new Error("Creation review is unavailable");
    const destination = {
      fundLiquidityToken: review.pool.liquidityToken,
      fundPair: review.pool.pair,
      fundHandler: review.pool.handler,
      fundDriver: review.pool.driver,
    }[name as (typeof FUNDING_STEPS)[number]];
    return buildTransferTarget(
      config.nativeHogAddress,
      destination,
      BigInt(workflow.fixedFundingPerContract),
    );
  }
  if (name === "approveToken0" || name === "approveToken1") {
    if (review === null) throw new Error("Creation review is unavailable");
    const token = name === "approveToken0" ? review.token0 : review.token1;
    return token.approvalDifference === 0n
      ? null
      : buildApprovalTarget(
          token.address,
          review.pool.handler,
          token.approvalDifference,
        );
  }
  if (name === "enqueue") {
    if (review === null) throw new Error("Creation review is unavailable");
    if (
      review.token0.approvalDifference !== 0n
      || review.token1.approvalDifference !== 0n
    ) {
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
  if (name === "crank") {
    return buildProcessRequestsTarget(addressFromHex(workflow.pool.driver));
  }
  return null;
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
      : "The transaction committed with a failed execution result";
  return update(updateStep(workflow, name, {
    status: "failed",
    transactionHash: result.hash,
    message,
  }));
}

function applyCommittedStep(
  config: GlobalConfig,
  workflow: CreationWorkflow,
  name: CreationStepName,
  receipt: TransactionReceipt,
  update: (workflow: CreationWorkflow) => CreationWorkflow,
): CreationWorkflow {
  let next = updateStep(workflow, name, {
    status: "committed",
    transactionHash: toHex0x(receipt.txHash),
    message: null,
  });
  if (name === "enqueue") {
    const created = PoolCreated.allFromReceipt(receipt, {
      contractAddress: config.factoryAddress,
    }).filter((event) => poolCreatedMatches(event, workflow));
    const accepted = RequestAccepted.allFromReceipt(receipt, {
      contractAddress: addressFromHex(workflow.pool.driver),
    });
    if (accepted.length === 1) {
      next = { ...next, requestId: toHex0x(accepted[0]!.topics.request_id) };
    }
    if (accepted.length !== 1 || created.length > 1) {
      return update({
        ...next,
        status: "race",
        updatedAt: Date.now(),
        steps: {
          ...next.steps,
          enqueue: {
            ...next.steps.enqueue,
            message: accepted.length !== 1
              ? "Creation could not be verified from one matching RequestAccepted event."
              : "Creation emitted conflicting PoolCreated evidence.",
          },
        },
      });
    }
    next = {
      ...next,
      status: "queued",
      updatedAt: Date.now(),
      steps: created.length === 0
        ? {
            ...next.steps,
            enqueue: {
              ...next.steps.enqueue,
              message:
                "Another creator may have won the pool race. The accepted liquidity request is preserved and will still be processed; this workflow does not claim pool creation.",
            },
          }
        : next.steps,
    };
  }
  if (name === "crank") {
    next = applyCreationReceipt(next, receipt);
    if (next.status === "queued") {
      next = {
        ...next,
        steps: {
          ...next.steps,
          crank: {
            ...next.steps.crank,
            message: "The crank committed without a matching terminal mint event.",
          },
        },
      };
    }
  }
  return update(next);
}

export function applyCreationReceipt(
  workflow: CreationWorkflow,
  receipt: TransactionReceipt,
): CreationWorkflow {
  if (workflow.status !== "queued" || workflow.requestId === null) return workflow;
  const minted = MintEvent.allFromReceipt(receipt, {
    contractAddress: addressFromHex(workflow.pool.pair),
  }).filter((event) => event.fields.request_id !== null
    && toHex0x(event.fields.request_id) === workflow.requestId
    && toHex0x(event.topics.sender) === workflow.pool.handler
    && event.fields.amount_minted > 0n);
  const failed = RequestFailed.allFromReceipt(receipt, {
    contractAddress: addressFromHex(workflow.pool.driver),
  }).filter((event) => toHex0x(event.topics.request_id) === workflow.requestId);
  if (minted.length > 1 || failed.length > 1 || (minted.length && failed.length)) {
    throw new Error("Queue receipt contains conflicting terminal creation events");
  }
  if (failed.length === 1) {
    return { ...workflow, status: "failed", updatedAt: Date.now() };
  }
  if (minted.length === 1) {
    return { ...workflow, status: "executed", updatedAt: Date.now() };
  }
  return workflow;
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

function assertReviewMatchesWorkflow(
  review: PoolCreationReview,
  workflow: CreationWorkflow,
): void {
  const matches = review.token0.addressHex === workflow.token0.address
    && review.token1.addressHex === workflow.token1.address
    && review.token0.amount === BigInt(workflow.token0.amount)
    && review.token1.amount === BigInt(workflow.token1.amount)
    && toHex0x(review.pool.liquidityToken) === workflow.pool.liquidityToken
    && toHex0x(review.pool.pair) === workflow.pool.pair
    && toHex0x(review.pool.handler) === workflow.pool.handler
    && toHex0x(review.pool.driver) === workflow.pool.driver;
  if (!matches) throw new Error("The factory prediction no longer matches the reviewed pool");
}

function poolCreatedMatches(
  event: ReturnType<typeof PoolCreated.allFromReceipt>[number],
  workflow: CreationWorkflow,
): boolean {
  return toHex0x(event.topics.token0) === workflow.token0.address
    && toHex0x(event.topics.token1) === workflow.token1.address
    && toHex0x(event.fields.liquidity_token) === workflow.pool.liquidityToken
    && toHex0x(event.fields.pair) === workflow.pool.pair
    && toHex0x(event.fields.handler) === workflow.pool.handler
    && toHex0x(event.fields.driver) === workflow.pool.driver;
}

function fundingSteps(): readonly CreationStepName[] {
  return FUNDING_STEPS;
}

function workflowAppConfig(
  config: GlobalConfig,
  workflow: CreationWorkflow,
): AppConfig {
  return {
    ...config,
    pairAddress: addressFromHex(workflow.pool.pair),
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
