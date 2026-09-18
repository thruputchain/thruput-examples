import {
  bytesEqual,
  fromHex0x,
  type CoreGroundhogClient,
} from "@groundhogchain/client";
import { DefaultWallet } from "@groundhogchain/client/contracts";
import { sha256Hash } from "@groundhogchain/protocol";
import type { AppConfig } from "@/config";
import { assertExpectedNetwork } from "@/groundhog/client";
import { outcomeFromReceipt, outcomeFromStatus } from "@/transactions/outcome";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";

// Observation uses only public RPC and remains usable after the wallet is disposed.
export function createTransactionObserver(
  config: Pick<AppConfig, "networkIdHex">,
  client: CoreGroundhogClient,
  options: { maxPolls?: number; delay?: () => Promise<void>; preserveWalletReturns?: boolean } = {},
): WriteBoundary["observe"] {
  return async (hashHex) => {
    if (!/^0x[0-9a-f]{64}$/.test(hashHex))
      return {
        kind: "preSubmissionFailure",
        hash: null,
        message: "The stored transaction hash is invalid",
      };
    const hash = sha256Hash(fromHex0x(hashHex));
    let errors = 0;
    let reason: Extract<WriteResult, { kind: "indeterminate" }>["reason"] =
      "timeout";
    for (let attempt = 0; attempt < (options.maxPolls ?? 40); attempt++) {
      try {
        await assertExpectedNetwork(client, config.networkIdHex);
        const receipt = await client.getTransactionReceipt(hash);
        if (receipt !== null) {
          if (!bytesEqual(receipt.txHash, hash))
            return { kind: "indeterminate", hash: hashHex, reason: "other" };
          const outcome = outcomeFromReceipt(receipt);
          if (outcome.kind === "committedSuccess") {
            if (options.preserveWalletReturns)
              return { kind: "committedSuccess", hash: hashHex, receipt };
            try {
              const returns =
                DefaultWallet.execute.decodeReceipt(receipt).value;
              if (returns.length !== 1)
                throw new Error("Expected one wallet child return");
              return {
                kind: "committedSuccess",
                hash: hashHex,
                receipt: { ...receipt, returnData: returns[0]! },
              };
            } catch {
              // Keep committed evidence; verification will report malformed return data.
              return {
                kind: "committedSuccess",
                hash: hashHex,
                receipt: { ...receipt, returnData: null },
              };
            }
          }
          if (outcome.kind === "committedFailure")
            return { kind: "committedFailure", hash: hashHex, receipt };
        }
        const outcome = outcomeFromStatus(
          await client.getTransactionStatus(hash),
        );
        errors = 0;
        if (outcome.kind === "invalid")
          return { kind: "invalid", hash: hashHex, reason: outcome.reason };
        if (outcome.kind === "indeterminate") reason = outcome.reason;
      } catch {
        if (++errors >= 2)
          return { kind: "indeterminate", hash: hashHex, reason: "disconnect" };
      }
      await (options.delay?.() ??
        new Promise((resolve) => setTimeout(resolve, 500)));
    }
    return { kind: "indeterminate", hash: hashHex, reason };
  };
}
