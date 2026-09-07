import type { AppConfig } from "@/config";
import type { LaunchWorkflow } from "@/launch/workflow";

export function createAmmPoolLink(
  validatedOrigin: AppConfig["swapAppUrl"],
  workflow: Pick<
    LaunchWorkflow,
    "creation" | "verification" | "createdAddressHex"
  > | null,
): string | null {
  if (
    !validatedOrigin ||
    workflow?.creation.status !== "committed" ||
    workflow.verification.status !== "complete" ||
    !workflow.createdAddressHex ||
    workflow.createdAddressHex.length !== 66 ||
    !/^0x[0-9a-fA-F]{64}$/.test(workflow.createdAddressHex) ||
    /^0x0{64}$/.test(workflow.createdAddressHex)
  ) {
    return null;
  }

  const url = new URL("/pools/new", validatedOrigin);
  url.search = new URLSearchParams({
    tokenA: workflow.createdAddressHex.toLowerCase(),
  }).toString();
  return url.href;
}
