import { fromHex0x, type GroundhogClient } from "@groundhogchain/client";
import { sha256Hash } from "@groundhogchain/protocol";
import { verifyReadNetwork } from "@/groundhog/client";
import { outcomeFromReceipt, outcomeFromStatus } from "./outcome";
import type { WriteResult } from "./write-boundary";

export async function pollTransaction(
  client: Pick<
    GroundhogClient,
    "getNetworkInfo" | "getTransactionReceipt" | "getTransactionStatus"
  >,
  hash: string,
  networkIdHex: string,
  maxPolls = 40,
  delay: (milliseconds: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<WriteResult> {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    return {
      kind: "preSubmissionFailure",
      hash: null,
      message: "The stored transaction hash is invalid",
    };
  }
  const bytes = sha256Hash(fromHex0x(hash));
  let errors = 0;
  let reason: Extract<WriteResult, { kind: "indeterminate" }>["reason"] =
    "timeout";
  for (let poll = 0; poll < maxPolls; poll += 1) {
    try {
      await verifyReadNetwork(client, { networkIdHex });
      const receipt = await client.getTransactionReceipt(bytes);
      if (receipt !== null) {
        if (
          receipt.txHash.length !== bytes.length ||
          !receipt.txHash.every((byte, index) => byte === bytes[index])
        ) {
          return { kind: "indeterminate", hash, reason: "other" };
        }
        const outcome = outcomeFromReceipt(receipt);
        if (
          outcome.kind === "committedSuccess" ||
          outcome.kind === "committedFailure"
        )
          return { ...outcome, hash };
        if (outcome.kind === "invalid" || outcome.kind === "indeterminate")
          return { ...outcome, hash };
        return { kind: "indeterminate", hash, reason: "timeout" };
      }
      const outcome = outcomeFromStatus(
        await client.getTransactionStatus(bytes),
      );
      errors = 0;
      if (outcome.kind === "invalid") return { ...outcome, hash };
      if (outcome.kind === "indeterminate") reason = outcome.reason;
    } catch {
      if (++errors >= 2)
        return { kind: "indeterminate", hash, reason: "disconnect" };
    }
    await delay(500);
  }
  return { kind: "indeterminate", hash, reason };
}
