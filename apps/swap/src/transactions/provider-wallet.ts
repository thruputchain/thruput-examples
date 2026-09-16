import { toHex0x, type GroundhogClient } from "@groundhogchain/client";
import type { ProviderWalletClient } from "@groundhogchain/client/wallet";
import { gasAmount, type Invocation } from "@groundhogchain/protocol";
import type { GlobalConfig } from "@/config";
import { verifyReadNetwork } from "@/groundhog/client";
import { SwapFactory } from "@/contracts/generated/swap-factory";
import { SwapDriver } from "@/contracts/generated/swap-driver";
import { CRANK_FRAME_GAS } from "@/contracts/driver-target";
import { fetchPoolTokenArtifact } from "./pool-token-artifact";
import { pollTransaction } from "./transaction-observation";
import type { WriteBoundary, WriteResult } from "./write-boundary";

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
    async supportsBatch(count) {
      if (!wallet) return false;
      return (
        ((await wallet.getCapabilities()).atomicBatch?.maxCalls ?? 0) >= count
      );
    },
    execute: (invocation, observer) =>
      executeTargets([invocation], observer, false),
    executeBatch: (invocations, observer) =>
      executeTargets(invocations, observer, true),
  };
  async function executeTargets(
    invocations: readonly Invocation[],
    observer: Parameters<WriteBoundary["execute"]>[1],
    batched: boolean,
  ): Promise<WriteResult> {
    if (!wallet)
      return {
        kind: "preSubmissionFailure",
        hash: null,
        message: "Connect a wallet to make changes",
      };
    let signed;
    try {
      await verifyReadNetwork(client, config);
      const isCreation = invocations.some(
        (invocation) =>
          toHex0x(invocation.invoked_address) ===
            toHex0x(config.factoryAddress) &&
          toHex0x(invocation.entrypoint) ===
            toHex0x(SwapFactory.createPair.entrypoint),
      );
      const contractsToDeploy = isCreation
        ? [
            await (options.loadArtifact ?? fetchPoolTokenArtifact)(
              config.poolTokenHash,
            ),
          ]
        : undefined;
      const isCrank = invocations.some(
        (invocation) =>
          toHex0x(invocation.entrypoint) ===
          toHex0x(SwapDriver.processRequests.entrypoint),
      );
      const preparation = {
        // Cover the driver frame plus wallet and transaction overhead. The
        // frame figure tracks the calibrated crank budget, so it does not have
        // to be restated here whenever that is recalibrated.
        gasLimit: gasAmount(
          batched
            ? invocations.reduce(
                (total, invocation) => total + invocation.gas_limit,
                WALLET_OVERHEAD_GAS,
              )
            : isCrank
              ? CRANK_FRAME_GAS + WALLET_OVERHEAD_GAS
              : 10_000_000n,
        ),
        expiryBlocks: 1_000n,
        ...(contractsToDeploy ? { contractsToDeploy } : {}),
      };
      const transaction = batched
        ? await wallet.prepareBatchExecution({ ...preparation, invocations })
        : await wallet.prepareExecution({
            ...preparation,
            invocation: invocations[0]!,
          });
      signed = await wallet.signTransaction(transaction);
      // Persist the approved hash before crossing the irreversible broadcast boundary.
      await observer?.onSigned(signed.hash);
    } catch (error) {
      return {
        kind: "preSubmissionFailure",
        hash: null,
        message:
          error instanceof Error ? error.message : "Wallet preparation failed",
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
  }
}
