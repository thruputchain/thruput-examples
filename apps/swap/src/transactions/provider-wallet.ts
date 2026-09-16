import { toHex0x, type GroundhogClient } from "@groundhogchain/client";
import type { ProviderWalletClient } from "@groundhogchain/client/wallet";
import { gasAmount } from "@groundhogchain/protocol";
import type { GlobalConfig } from "@/config";
import { verifyReadNetwork } from "@/groundhog/client";
import { SwapFactory } from "@/contracts/generated/swap-factory";
import { SwapDriver } from "@/contracts/generated/swap-driver";
import { CRANK_FRAME_GAS } from "@/contracts/driver-target";
import { fetchPoolTokenArtifact } from "./pool-token-artifact";
import { pollTransaction } from "./transaction-observation";
import type { WriteBoundary } from "./write-boundary";

// What the transaction needs beyond the driver frame itself: the wallet
// account's own work and the transaction envelope around the invocation.
const WALLET_OVERHEAD_GAS = 5_000_000n;

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
    pollTransaction(
      client,
      hash,
      config.networkIdHex,
      options.maxPolls,
      options.delay,
    );
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
        await verifyReadNetwork(client, config);
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
        const isCrank =
          toHex0x(invocation.entrypoint) ===
          toHex0x(SwapDriver.processRequests.entrypoint);
        const transaction = await wallet.prepareExecution({
          invocation,
          // Cover the driver frame plus wallet and transaction overhead. The
          // frame figure tracks the calibrated crank budget, so it does not have
          // to be restated here whenever that is recalibrated.
          gasLimit: gasAmount(
            isCrank ? CRANK_FRAME_GAS + WALLET_OVERHEAD_GAS : 10_000_000n,
          ),
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
        await wallet.submitTransaction(signed);
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
