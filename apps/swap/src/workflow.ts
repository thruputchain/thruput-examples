export type TransactionPhase = "approval" | "swap";
export type FailureCertainty = "notSubmitted" | "invalid" | "committed";

export interface SwapIntent {
  amountIn: bigint;
  amountOutMin: bigint;
}

type TransactionFailure =
  | { certainty: "notSubmitted"; transactionHash: null }
  | { certainty: "invalid" | "committed"; transactionHash: string };

export type WorkflowState =
  | { status: "idle" }
  | { status: "quoting" }
  | { status: "readyToApprove"; intent: SwapIntent }
  | { status: "approving"; intent: SwapIntent }
  | { status: "readyToSwap"; intent: SwapIntent }
  | { status: "submitting"; intent: SwapIntent }
  | {
      status: "indeterminate";
      phase: TransactionPhase;
      intent: SwapIntent;
      transactionHash: string | null;
    }
  | {
      status: "queued";
      intent: SwapIntent;
      transactionHash: string;
      receiptBlock: bigint;
    }
  | {
      status: "executionObserved";
      intent: SwapIntent;
      transactionHash: string;
    }
  | {
      status: "queuedNotObserved";
      intent: SwapIntent;
      transactionHash: string;
      receiptBlock: bigint;
    }
  | {
      status: "error";
      phase: TransactionPhase;
      message: string;
      retryAllowed: boolean;
      intent: SwapIntent;
      certainty: FailureCertainty;
      transactionHash: string | null;
    };

export type WorkflowEvent =
  | { type: "inputChanged" }
  | { type: "approvalRequired"; intent: SwapIntent }
  | { type: "quoteReady"; intent: SwapIntent }
  | { type: "approvalStarted" }
  | { type: "approvalObserved" }
  | { type: "submissionStarted" }
  | { type: "submissionRefreshed"; intent: SwapIntent }
  | {
      type: "transactionIndeterminate";
      transactionHash: string | null;
    }
  | ({
      type: "transactionFailed";
      message: string;
    } & TransactionFailure)
  | { type: "requestQueued"; transactionHash: string; receiptBlock: bigint }
  | { type: "executionObserved" }
  | { type: "executionFailed" }
  | { type: "observationTimedOut" }
  | { type: "clearObserved" }
  | { type: "acknowledgeCommittedFailure" }
  | { type: "confirmExternalCrank" }
  | { type: "outstandingClearedElsewhere" };

export const initialWorkflowState: WorkflowState = { status: "idle" };

export class InvalidWorkflowTransition extends Error {
  constructor(state: WorkflowState["status"], event: WorkflowEvent["type"]) {
    super(`Cannot apply ${event} while workflow is ${state}`);
    this.name = "InvalidWorkflowTransition";
  }
}

export function workflowReducer(
  state: WorkflowState,
  event: WorkflowEvent,
): WorkflowState {
  if (event.type === "outstandingClearedElsewhere") {
    return [
      "approving",
      "submitting",
      "indeterminate",
      "queued",
      "queuedNotObserved",
    ].includes(state.status) ||
    (state.status === "error" && !state.retryAllowed)
      ? initialWorkflowState
      : state;
  }
  if (event.type === "inputChanged") {
    if (
      [
        "approving",
        "submitting",
        "indeterminate",
        "queued",
        "queuedNotObserved",
      ].includes(state.status)
      || (state.status === "error" && !state.retryAllowed)
    ) {
      throw new InvalidWorkflowTransition(state.status, event.type);
    }
    return { status: "quoting" };
  }

  switch (state.status) {
    case "idle":
      break;
    case "quoting":
      if (event.type === "approvalRequired") {
        return { status: "readyToApprove", intent: event.intent };
      }
      if (event.type === "quoteReady") {
        return { status: "readyToSwap", intent: event.intent };
      }
      break;
    case "readyToApprove":
      if (event.type === "approvalStarted") {
        return { status: "approving", intent: state.intent };
      }
      break;
    case "approving":
      if (event.type === "approvalObserved") {
        return { status: "readyToSwap", intent: state.intent };
      }
      if (event.type === "transactionIndeterminate") {
        return {
          status: "indeterminate",
          phase: "approval",
          intent: state.intent,
          transactionHash: event.transactionHash,
        };
      }
      if (event.type === "transactionFailed") {
        return failure("approval", state.intent, event);
      }
      break;
    case "readyToSwap":
      if (event.type === "submissionStarted") {
        return { status: "submitting", intent: state.intent };
      }
      break;
    case "submitting":
      if (event.type === "submissionRefreshed") {
        return { status: "submitting", intent: event.intent };
      }
      if (event.type === "requestQueued") {
        return {
          status: "queued",
          intent: state.intent,
          transactionHash: event.transactionHash,
          receiptBlock: event.receiptBlock,
        };
      }
      if (event.type === "transactionIndeterminate") {
        return {
          status: "indeterminate",
          phase: "swap",
          intent: state.intent,
          transactionHash: event.transactionHash,
        };
      }
      if (event.type === "transactionFailed") {
        return failure("swap", state.intent, event);
      }
      break;
    case "queued":
      if (event.type === "executionObserved") {
        return observed(state);
      }
      if (event.type === "executionFailed") {
        return initialWorkflowState;
      }
      if (event.type === "observationTimedOut") {
        return { ...state, status: "queuedNotObserved" };
      }
      if (event.type === "confirmExternalCrank") {
        return initialWorkflowState;
      }
      break;
    case "queuedNotObserved":
      if (event.type === "executionObserved") {
        return observed(state);
      }
      if (event.type === "executionFailed") {
        return initialWorkflowState;
      }
      if (event.type === "confirmExternalCrank") {
        return initialWorkflowState;
      }
      break;
    case "executionObserved":
      if (event.type === "clearObserved") {
        return initialWorkflowState;
      }
      break;
    case "error":
      if (
        event.type === "acknowledgeCommittedFailure"
        && state.certainty === "committed"
      ) {
        return initialWorkflowState;
      }
      break;
    case "indeterminate":
      break;
  }

  throw new InvalidWorkflowTransition(state.status, event.type);
}

function failure(
  phase: TransactionPhase,
  intent: SwapIntent,
  event: Extract<WorkflowEvent, { type: "transactionFailed" }>,
): WorkflowState {
  return {
    status: "error",
    phase,
    intent,
    message: event.message,
    retryAllowed:
      event.certainty === "notSubmitted" || event.certainty === "invalid",
    certainty: event.certainty,
    transactionHash: event.transactionHash,
  };
}

function observed(
  state: Extract<WorkflowState, { status: "queued" | "queuedNotObserved" }>,
): WorkflowState {
  return {
    status: "executionObserved",
    intent: state.intent,
    transactionHash: state.transactionHash,
  };
}
