import { addressFromBase58, toBase58 } from "@thruputchain/client";

import type { AppConfig } from "@/config";
import type { LaunchWorkflow } from "@/launch/workflow";

export function createAmmPoolLink(
  validatedOrigin: AppConfig["swapAppUrl"],
  workflow: Pick<
    LaunchWorkflow,
    "creation" | "verification" | "createdAddress"
  > | null,
): string | null {
  if (
    !validatedOrigin ||
    workflow?.creation.status !== "committed" ||
    workflow.verification.status !== "complete" ||
    !workflow.createdAddress ||
    !isNonzeroAddress(workflow.createdAddress)
  ) {
    return null;
  }

  const url = new URL("/pools/new", validatedOrigin);
  url.search = new URLSearchParams({
    tokenA: workflow.createdAddress,
  }).toString();
  return url.href;
}

function isNonzeroAddress(value: string): boolean {
  try {
    const address = addressFromBase58(value);
    return toBase58(address) === value && address.some((byte) => byte !== 0);
  } catch {
    return false;
  }
}
