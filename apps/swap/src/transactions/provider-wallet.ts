import { toHex0x, type GroundhogClient } from "@groundhogchain/client";
import type { ProviderWalletClient } from "@groundhogchain/client/wallet";
import { gasAmount } from "@groundhogchain/protocol";
import type { GlobalConfig } from "@/config";
import { SwapFactory } from "@/contracts/generated/swap-factory";
import { fetchPoolTokenArtifact } from "./pool-token-artifact";
import { pollTransaction } from "./transaction-observation";
import type { WriteBoundary } from "./write-boundary";

export function createProviderWriteBoundary(
  config: GlobalConfig,
  client: GroundhogClient,
  wallet?: ProviderWalletClient,
  options: {
    maxPolls?: number;
    delay?: (ms: number) => Promise<void>;
    loadArtifact?: typeof fetchPoolTokenArtifact;
  } = {},
): WriteBoundary {
  const observe = (hash: string) =>
    pollTransaction(client, hash, options.maxPolls, options.delay);
  return {
    observe,
    async execute(invocation, observer) {
      if (!wallet)
        return {
          kind: "preSubmissionFailure",
          hash: null,
          message: "Connect a wallet to make changes",
        };
      let signed;
      try {
        const isCreation =
          toHex0x(invocation.invoked_address) ===
            toHex0x(config.factoryAddress) &&
          toHex0x(invocation.entrypoint) ===
            toHex0x(SwapFactory.createPair.entrypoint);
        const contractsToDeploy = isCreation
          ? [
              await (options.loadArtifact ?? fetchPoolTokenArtifact)(
                config.poolTokenHash,
              ),
            ]
          : undefined;
        const transaction = await wallet.prepareExecution({
          invocation,
          gasLimit: gasAmount(10_000_000n),
          expiryBlocks: 1_000n,
          ...(contractsToDeploy ? { contractsToDeploy } : {}),
        });
        signed = await wallet.signTransaction(transaction);
        // Persist the approved hash before crossing the irreversible broadcast boundary.
        await observer?.onSigned(signed.hash);
      } catch (error) {
        return {
          kind: "preSubmissionFailure",
          hash: null,
          message:
            error instanceof Error
              ? error.message
              : "Wallet preparation failed",
        };
      }
      try {
        const submitted = await wallet.submitTransaction(signed);
        if (submitted.hash !== signed.hash)
          return { kind: "indeterminate", hash: signed.hash, reason: "other" };
      } catch {
        const result = await observe(signed.hash);
        return result.kind === "indeterminate" && result.reason === "timeout"
          ? { ...result, reason: "disconnect" }
          : result;
      }
      return observe(signed.hash);
    },
  };
}
