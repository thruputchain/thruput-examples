import { describe, expect, it } from "vitest";

import {
  initialWorkflowState,
  InvalidWorkflowTransition,
  workflowReducer,
  type SwapIntent,
  type WorkflowState,
} from "./workflow";

const intent: SwapIntent = { amountIn: 10n, amountOutMin: 9n };

function reduce(
  state: WorkflowState,
  ...events: Parameters<typeof workflowReducer>[1][]
): WorkflowState {
  return events.reduce(workflowReducer, state);
}

describe("workflowReducer", () => {
  it("replaces rendered intent with the fresh submitted intent", () => {
    const submitting = reduce(
      initialWorkflowState,
      { type: "inputChanged" },
      { type: "quoteReady", intent },
      { type: "submissionStarted" },
    );
    const freshIntent = { amountIn: 11n, amountOutMin: 8n };

    expect(
      workflowReducer(submitting, {
        type: "submissionRefreshed",
        intent: freshIntent,
      }),
    ).toEqual({ status: "submitting", intent: freshIntent });
  });

  it("requires explicit acknowledgement before clearing a committed failure", () => {
    const failed = workflowReducer(
      { status: "submitting", intent },
      {
        type: "transactionFailed",
        certainty: "committed",
        transactionHash: "0xdead",
        message: "reverted",
      },
    );

    expect(() => workflowReducer(failed, { type: "inputChanged" })).toThrow();
    expect(
      workflowReducer(failed, { type: "acknowledgeCommittedFailure" }),
    ).toEqual(initialWorkflowState);
  });

  it("moves through approval, submission, queueing, and observation", () => {
    const state = reduce(
      initialWorkflowState,
      { type: "inputChanged" },
      { type: "approvalRequired", intent },
      { type: "approvalStarted" },
      { type: "approvalObserved" },
      { type: "submissionStarted" },
      { type: "requestQueued", transactionHash: "0x01", receiptBlock: 7n },
      { type: "executionObserved" },
    );

    expect(state).toEqual({
      status: "executionObserved",
      intent,
      transactionHash: "0x01",
    });
  });

  it("keeps an observation timeout queued and nonterminal", () => {
    const queued = reduce(
      { status: "quoting" },
      { type: "quoteReady", intent },
      { type: "submissionStarted" },
      { type: "requestQueued", transactionHash: "0x01", receiptBlock: 7n },
      { type: "observationTimedOut" },
    );

    expect(queued.status).toBe("queuedNotObserved");
    expect(() => workflowReducer(queued, { type: "inputChanged" })).toThrow(
      InvalidWorkflowTransition,
    );
    expect(
      workflowReducer(queued, { type: "confirmExternalCrank" }),
    ).toEqual(initialWorkflowState);
  });

  it("unlocks a queued workflow when another tab clears its durable request", () => {
    const queued: WorkflowState = {
      status: "queued",
      intent,
      transactionHash: "0x01",
      receiptBlock: 7n,
    };

    expect(
      workflowReducer(queued, { type: "outstandingClearedElsewhere" }),
    ).toEqual(initialWorkflowState);
  });

  it.each([
    { status: "approving", intent },
    { status: "submitting", intent },
    {
      status: "indeterminate",
      phase: "swap",
      intent,
      transactionHash: "0x01",
    },
    {
      status: "error",
      phase: "swap",
      message: "failed",
      retryAllowed: false,
      intent,
      certainty: "committed",
      transactionHash: "0x01",
    },
  ] satisfies WorkflowState[])(
    "unlocks $status when its durable request is cleared elsewhere",
    (state) => {
      expect(
        workflowReducer(state, { type: "outstandingClearedElsewhere" }),
      ).toEqual(initialWorkflowState);
    },
  );

  it.each(["approval", "swap"] as const)(
    "makes an indeterminate %s transaction non-resubmittable",
    (phase) => {
      const active: WorkflowState =
        phase === "approval"
          ? { status: "approving", intent }
          : { status: "submitting", intent };
      const state = workflowReducer(active, {
        type: "transactionIndeterminate",
        transactionHash: "0x01",
      });

      expect(state).toMatchObject({ status: "indeterminate", phase });
      expect(() =>
        workflowReducer(state, { type: "submissionStarted" }),
      ).toThrow(InvalidWorkflowTransition);
      expect(() => workflowReducer(state, { type: "inputChanged" })).toThrow(
        InvalidWorkflowTransition,
      );
    },
  );

  it("rejects transitions that skip required states", () => {
    expect(() =>
      workflowReducer(initialWorkflowState, { type: "submissionStarted" }),
    ).toThrow(InvalidWorkflowTransition);
  });

  it.each(["notSubmitted", "invalid"] as const)(
    "allows new input after a %s failure",
    (certainty) => {
      const event =
        certainty === "notSubmitted"
          ? {
              type: "transactionFailed" as const,
              message: "failed",
              certainty,
              transactionHash: null,
            }
          : {
              type: "transactionFailed" as const,
              message: "failed",
              certainty,
              transactionHash: "0x01",
            };
      const error = workflowReducer({ status: "submitting", intent }, event);

      expect(error).toMatchObject({
        status: "error",
        certainty,
        retryAllowed: true,
      });
      expect(workflowReducer(error, { type: "inputChanged" })).toEqual({
        status: "quoting",
      });
    },
  );

  it("retains a committed failure hash and prevents a fresh retry", () => {
    const error = workflowReducer({ status: "submitting", intent }, {
      type: "transactionFailed",
      message: "reverted",
      certainty: "committed",
      transactionHash: "0x01",
    });

    expect(error).toMatchObject({
      status: "error",
      certainty: "committed",
      transactionHash: "0x01",
      retryAllowed: false,
    });
    expect(() => workflowReducer(error, { type: "inputChanged" })).toThrow(
      InvalidWorkflowTransition,
    );
  });
});
