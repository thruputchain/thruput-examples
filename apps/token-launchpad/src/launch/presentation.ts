import type { LaunchWorkflow } from "./workflow";

export function canDiscardWorkflow(workflow: LaunchWorkflow): boolean {
  return (
    workflow.creation.status === "committed" ||
    (workflow.funding.status === "idle" &&
      workflow.funding.hash === null &&
      workflow.creation.status === "idle" &&
      workflow.creation.hash === null)
  );
}

export function actionLabel(workflow: LaunchWorkflow, manual: boolean): string {
  if (
    !manual &&
    !workflow.error &&
    workflow.funding.status === "idle" &&
    workflow.creation.status === "idle"
  )
    return "Launch token";
  if (workflow.funding.status !== "committed") {
    if (workflow.funding.status === "signing")
      return "Confirm no funding was signed";
    if (
      workflow.funding.status === "failed" ||
      (workflow.funding.status === "idle" && workflow.error)
    )
      return "Retry funding";
    return workflow.funding.hash
      ? "Check funding transaction"
      : "Fund token address";
  }
  if (workflow.creation.status === "signing")
    return "Confirm no creation was signed";
  if (
    workflow.creation.status === "failed" ||
    (workflow.creation.status === "idle" && workflow.error)
  )
    return "Retry creation";
  return workflow.creation.hash ? "Check creation transaction" : "Create token";
}

export function loadingActionLabel(
  workflow: LaunchWorkflow,
  manual: boolean,
): string {
  if (
    workflow.funding.status === "signing" ||
    workflow.creation.status === "signing"
  )
    return "Waiting for wallet approval...";
  if (
    [workflow.funding.status, workflow.creation.status].some(
      (status) => status === "pending" || status === "uncertain",
    )
  )
    return "Checking transaction...";
  if (!manual) return "Launching token...";
  return workflow.funding.status === "committed"
    ? "Creating token..."
    : "Funding token...";
}
