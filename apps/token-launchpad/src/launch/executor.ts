import {
  addressFromHex,
  bytesEqual,
  fixedBytes,
  fromHex0x,
  type GroundhogClient,
} from "@groundhogchain/client";
import { ExecResult, gasAmount, sha256Hash } from "@groundhogchain/protocol";

import type { AppConfig } from "@/config";
import { userErrorMessage } from "@/errors";
import {
  StandardTokenFactory,
  TokenCreated,
} from "@/contracts/generated/standard-token-factory";
import { ERC20, TransferEvent } from "@/contracts/generated/standard-token";
import { reviewFactory } from "@/contracts/launchpad-client";
import {
  assertWorkflowScope,
  loadWorkflow,
  saveWorkflow,
  workflowStorageKey,
  withWorkflowLock,
  withWorkflowSessionLock,
  workflowIntent,
  type LaunchWorkflow,
  type WorkflowStep,
} from "@/launch/workflow";
import {
  readAndAssessTokenState,
  validateCreationEvidence,
} from "@/launch/verification";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";

const GAS_LIMIT = gasAmount(10_000_000n);

export async function advanceWorkflow(input: {
  config: AppConfig;
  client: GroundhogClient;
  writer: WriteBoundary;
  workflowId: string;
  workflowRevision: number;
  expectedIntent: string;
  confirmUnsignedStep?: "funding" | "creation";
  storage?: Pick<Storage, "getItem" | "setItem">;
  locks?: LockManager;
  review?: typeof reviewFactory;
}): Promise<LaunchWorkflow> {
  const storage = input.storage ?? window.localStorage;
  return withWorkflowLock(
    input.config,
    async () => {
      const key = workflowStorageKey(input.config);
      let workflow = loadWorkflow(storage, key);
      if (
        workflow === null ||
        workflow.id !== input.workflowId ||
        workflow.revision !== input.workflowRevision ||
        workflowIntent(workflow) !== input.expectedIntent
      ) {
        throw new Error(
          "This launch changed in another tab. Reload before continuing.",
        );
      }
      assertWorkflowScope(workflow, input.config);
      const nonce = fixedBytes(fromHex0x(workflow.nonceHex), 32);
      let review = await (input.review ?? reviewFactory)(
        input.client,
        input.config,
        nonce,
        { balanceItemKnown: workflow.funding.status === "committed" },
      );
      if (
        workflow.funding.status === "committed" &&
        workflow.funding.hash !== null &&
        (workflow.creation.status === "idle" ||
          workflow.creation.status === "failed") &&
        review.fundingAmount > 0n
      ) {
        const hash = sha256Hash(fromHex0x(workflow.funding.hash));
        const receipt = await input.client.getTransactionReceipt(hash);
        if (
          !receipt ||
          !bytesEqual(receipt.txHash, hash) ||
          receipt.execResult !== ExecResult.ExecResultOK
        ) {
          throw new Error(
            "Funding evidence is unavailable. Check again before creating the token.",
          );
        }
        // Receipt indexing can lead the state snapshot used by views. Retry only
        // a proven stale read, never a fresh shortfall or the funding transaction.
        if (review.reserveHeight < receipt.height) {
          review = await (input.review ?? reviewFactory)(
            input.client,
            input.config,
            nonce,
            { balanceItemKnown: true },
          );
          if (review.reserveHeight < receipt.height) {
            throw new Error(
              "Funding committed, but the reserve snapshot has not reached its block yet. Check again.",
            );
          }
        }
      }
      const reviewedFeeRecipient = workflow.reviewedFeeRecipientHex
        ? addressFromHex(workflow.reviewedFeeRecipientHex)
        : null;
      if (
        review.predictedAddressHex !== workflow.predictedAddressHex ||
        !bytesEqual(
          review.config.native_token,
          addressFromHex(workflow.reviewedNativeTokenHex),
        ) ||
        !bytesEqual(
          review.config.token_code_hash,
          fromHex0x(workflow.reviewedTokenCodeHashHex),
        ) ||
        review.config.required_token_funding.toString() !==
          workflow.requiredTokenFunding ||
        review.config.creation_fee.toString() !==
          workflow.reviewedCreationFee ||
        (review.config.fee_recipient === null) !==
          (reviewedFeeRecipient === null) ||
        (review.config.fee_recipient !== null &&
          reviewedFeeRecipient !== null &&
          !bytesEqual(review.config.fee_recipient, reviewedFeeRecipient))
      ) {
        throw new Error(
          "The reviewed factory state changed. This launch has been paused.",
        );
      }

      if (
        workflow.funding.status !== "committed" &&
        workflow.funding.status !== "pending" &&
        workflow.funding.status !== "uncertain" &&
        workflow.funding.status !== "signing" &&
        (workflow.plannedFundingAmount !== review.fundingAmount.toString() ||
          workflow.plannedReserve !== review.currentReserve.toString())
      ) {
        workflow = {
          ...workflow,
          revision: workflow.revision + 1,
          plannedFundingAmount: review.fundingAmount.toString(),
          plannedReserve: review.currentReserve.toString(),
          error: null,
        };
        saveWorkflow(storage, key, workflow);
        return workflow;
      }
      if (
        workflow.funding.status !== "committed" &&
        workflow.funding.status !== "pending" &&
        workflow.funding.status !== "uncertain" &&
        workflow.funding.status !== "signing" &&
        review.fundingShortfall > 0n
      ) {
        throw new Error(
          `Insufficient HOG: This wallet needs at least ${review.fundingShortfall} more HOG for token funding. Execution costs may require additional HOG.`,
        );
      }
      if (workflow.funding.status !== "committed") {
        const mustResolveEvidence =
          workflow.funding.status === "signing" ||
          workflow.funding.status === "pending" ||
          workflow.funding.status === "uncertain";
        if (review.fundingAmount === 0n && !mustResolveEvidence) {
          workflow = {
            ...workflow,
            revision: workflow.revision + 1,
            funding: { status: "committed", hash: workflow.funding.hash },
            error: null,
          };
          saveWorkflow(storage, key, workflow);
          return workflow;
        } else {
          return continueStep({
            workflow,
            stepName: "funding",
            storage,
            key,
            writer: input.writer,
            invocation: ERC20.transfer.invocation(
              input.config.nativeHogAddress,
              GAS_LIMIT,
              {
                receiver: review.predictedAddress,
                amount: review.fundingAmount,
              },
            ),
            confirmUnsigned: input.confirmUnsignedStep === "funding",
          });
        }
      }

      if (workflow.creation.status === "committed") {
        if (workflow.verification.status === "complete") return workflow;
        const created = addressFromHex(workflow.createdAddressHex!);
        workflow = {
          ...workflow,
          revision: workflow.revision + 1,
          verification: await readAndAssessTokenState({
            client: input.client,
            token: created,
            caller: input.config.accountAddress,
            workflow,
          }),
        };
        saveWorkflow(storage, key, workflow);
        return workflow;
      }
      const resolvingCreationEvidence =
        workflow.creation.status === "signing" ||
        workflow.creation.status === "pending" ||
        workflow.creation.status === "uncertain";
      if (!resolvingCreationEvidence && review.fundingAmount > 0n) {
        throw new Error(
          "The funding transaction committed, but the required reserve is not available.",
        );
      }
      return continueStep({
        workflow,
        stepName: "creation",
        storage,
        key,
        writer: input.writer,
        invocation: StandardTokenFactory.createToken.invocation(
          input.config.factoryAddress,
          GAS_LIMIT,
          {
            nonce,
            administrator: input.config.accountAddress,
            name: workflow.token.name,
            symbol: workflow.token.symbol,
            decimals: BigInt(workflow.token.decimals),
            initialHolder: input.config.accountAddress,
            initialSupply: BigInt(workflow.token.initialSupply),
          },
        ),
        async onCommitted(result, current) {
          const created = StandardTokenFactory.createToken.decodeReceipt(
            result.receipt,
          ).value;
          const event = TokenCreated.singleFromReceipt(result.receipt, {
            contractAddress: input.config.factoryAddress,
          });
          const mintEvents = TransferEvent.allFromReceipt(result.receipt, {
            contractAddress: created,
          });
          validateCreationEvidence({
            created,
            predicted: addressFromHex(current.predictedAddressHex),
            creator: input.config.accountAddress,
            expectedTokenHash: input.config.expectedTokenHash,
            workflow: current,
            createdEvent: event,
            mintEvents,
          });
          return {
            ...current,
            createdAddressHex: current.predictedAddressHex,
            creationBlock: result.receipt.height.toString(),
            verification: await readAndAssessTokenState({
              client: input.client,
              token: created,
              caller: input.config.accountAddress,
              workflow: current,
            }),
          };
        },
        confirmUnsigned: input.confirmUnsignedStep === "creation",
      });
    },
    input.locks,
  );
}

export async function runWorkflow(
  input: Parameters<typeof advanceWorkflow>[0] & {
    automatic: boolean;
    onUpdate?: (workflow: LaunchWorkflow) => void;
  },
): Promise<LaunchWorkflow> {
  const { automatic, onUpdate, ...advanceInput } = input;
  const run = async () => {
    let workflow = await advanceWorkflow(advanceInput);
    onUpdate?.(workflow);
    if (
      !automatic ||
      advanceInput.confirmUnsignedStep !== undefined ||
      workflow.error !== null ||
      workflow.funding.status !== "committed" ||
      workflow.creation.status !== "idle"
    ) {
      return workflow;
    }
    workflow = await advanceWorkflow({
      ...advanceInput,
      workflowRevision: workflow.revision,
    });
    onUpdate?.(workflow);
    return workflow;
  };
  return automatic
    ? withWorkflowSessionLock(input.config, run, input.locks)
    : run();
}

async function continueStep(input: {
  workflow: LaunchWorkflow;
  stepName: "funding" | "creation";
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
  writer: WriteBoundary;
  invocation: Parameters<WriteBoundary["execute"]>[0];
  confirmUnsigned: boolean;
  onCommitted?: (
    result: Extract<WriteResult, { kind: "committedSuccess" }>,
    workflow: LaunchWorkflow,
  ) => LaunchWorkflow | Promise<LaunchWorkflow>;
}): Promise<LaunchWorkflow> {
  let workflow = input.workflow;
  const step = workflow[input.stepName];
  if (step.status === "signing") {
    if (!input.confirmUnsigned) {
      throw new Error(
        "Confirm that no transaction was signed before this workflow can continue.",
      );
    }
    workflow = updateStep(
      workflow,
      input.stepName,
      { status: "idle", hash: null },
      null,
    );
    saveWorkflow(input.storage, input.key, workflow);
    return workflow;
  }
  let result: WriteResult;
  if (
    step.hash !== null &&
    (step.status === "pending" || step.status === "uncertain")
  ) {
    result = await input.writer.observe(step.hash);
  } else {
    workflow = updateStep(
      workflow,
      input.stepName,
      { status: "signing", hash: null },
      null,
    );
    saveWorkflow(input.storage, input.key, workflow);
    result = await input.writer.execute(input.invocation, {
      onSigned(hash) {
        workflow = updateStep(
          workflow,
          input.stepName,
          { status: "pending", hash },
          null,
        );
        saveWorkflow(input.storage, input.key, workflow);
      },
    });
  }
  switch (result.kind) {
    case "preSubmissionFailure":
      workflow = updateStep(
        workflow,
        input.stepName,
        { status: "idle", hash: null },
        userErrorMessage(
          new Error(result.message),
          "The transaction could not be prepared",
        ),
      );
      break;
    case "invalid":
      workflow = updateStep(
        workflow,
        input.stepName,
        { status: "failed", hash: result.hash },
        userErrorMessage(
          new Error(`Transaction rejected: ${result.reason}`),
          "The transaction was rejected",
        ),
      );
      break;
    case "committedFailure":
      workflow = updateStep(
        workflow,
        input.stepName,
        { status: "failed", hash: result.hash },
        input.stepName === "funding"
          ? "Funding failed. No token was created."
          : "Creation failed. Funding remains at the predicted address.",
      );
      break;
    case "indeterminate":
      workflow = updateStep(
        workflow,
        input.stepName,
        { status: "uncertain", hash: result.hash },
        "The transaction may still commit. Check it again before retrying.",
      );
      break;
    case "committedSuccess":
      workflow = updateStep(
        workflow,
        input.stepName,
        { status: "committed", hash: result.hash },
        null,
      );
      workflow = (await input.onCommitted?.(result, workflow)) ?? workflow;
      break;
  }
  saveWorkflow(input.storage, input.key, workflow);
  return workflow;
}

function updateStep(
  workflow: LaunchWorkflow,
  name: "funding" | "creation",
  step: WorkflowStep,
  error: string | null,
): LaunchWorkflow {
  return {
    ...workflow,
    revision: workflow.revision + 1,
    [name]: step,
    error,
  };
}
