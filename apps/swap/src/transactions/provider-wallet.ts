import {
  hashFromHex,
  toHex0x,
  type CoreGroundhogClient,
} from "@groundhogchain/client";
import {
  submitAndObserve,
  walletGasLimit,
  type ProviderWalletClient,
} from "@groundhogchain/client/wallet";
import {
  gasAmount,
  networkHash,
  type Invocation,
} from "@groundhogchain/protocol";
import type { GlobalConfig } from "@/config";
import { verifyReadNetwork } from "@/groundhog/client";
import { SwapFactory } from "@/contracts/generated/swap-factory";
import { SwapDriver } from "@/contracts/generated/swap-driver";
import { CRANK_FRAME_GAS } from "@/contracts/driver-target";
import { fetchPoolTokenArtifact } from "./pool-token-artifact";
import {
  createTransactionObserver,
  executionFailure,
  receiptResult,
} from "./transaction-observation";
import type { WriteBoundary, WriteResult } from "./write-boundary";

// What the transaction needs beyond the driver frame itself: the wallet
// account's own work and the transaction envelope around the invocation.
const WALLET_OVERHEAD_GAS = 5_000_000n;

export function createProviderWriteBoundary(
  config: GlobalConfig,
  client: CoreGroundhogClient,
  wallet?: ProviderWalletClient,
  options: {
    loadArtifact?: typeof fetchPoolTokenArtifact;
  } = {},
): WriteBoundary {
  const observe = createTransactionObserver(config, client);
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
    try {
      await verifyReadNetwork(client, config);
      const isCreation = invocations.some(
        (invocation) =>
          toHex0x(invocation.invoked_address) ===
            toHex0x(config.factoryAddress) &&
          toHex0x(invocation.entrypoint) ===
            toHex0x(SwapFactory.v0_1.createPair.entrypoint),
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
          toHex0x(SwapDriver.v0_1.processRequests.entrypoint),
      );
      const preparation = {
        // Cover the driver frame plus wallet and transaction overhead. The
        // frame figure tracks the calibrated crank budget, so it does not have
        // to be restated here whenever that is recalibrated.
        gasLimit: gasAmount(
          batched
            ? walletGasLimit(invocations, gasAmount(WALLET_OVERHEAD_GAS))
            : isCrank
              ? CRANK_FRAME_GAS + WALLET_OVERHEAD_GAS
              : 10_000_000n,
        ),
        expiryBlocks: 1_000n,
        ...(contractsToDeploy ? { contractsToDeploy } : {}),
      };
      const wait = {
        expectedNetworkHash: networkHash(
          hashFromHex(`0x${config.networkIdHex}`),
        ),
        timeoutMs: 20_000,
        pollingIntervalMs: 500,
      };
      if (!batched) {
        const result = await wallet.executeAndWait(
          { ...preparation, invocation: invocations[0]! },
          { onSigned: ({ hash }) => observer?.onSigned(hash), wait },
        );
        return receiptResult(result.receipt);
      }
      // Queued swap workflows use raw targets and verify completion events later.
      const transaction = await wallet.prepareBatchExecution({
        ...preparation,
        invocations,
      });
      const signed = await wallet.signTransaction(transaction);
      await observer?.onSigned(signed.hash);
      const result = await submitAndObserve(
        client,
        hashFromHex(signed.hash),
        () => wallet.submitTransaction(signed),
        wait,
      );
      return receiptResult(result.receipt);
    } catch (error) {
      const result = executionFailure(error);
      if (result) return result;
      return {
        kind: "preSubmissionFailure",
        hash: null,
        message:
          error instanceof Error ? error.message : "Wallet preparation failed",
      };
    }
  }
}
