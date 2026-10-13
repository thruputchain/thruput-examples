import { bytesEqual, type CoreThruputClient } from "@thruputchain/client";
import {
  walletGasLimit,
  type ProviderWalletClient,
} from "@thruputchain/client/wallet";
import type { ContractCall } from "@thruputchain/client/contract";
import { gasAmount } from "@thruputchain/protocol";
import type { AppConfig } from "@/config";
import { StandardTokenFactory } from "@/contracts/generated/standard-token-factory";
import { loadStandardTokenArtifact } from "@/contracts/token-artifact";
import { userErrorMessage } from "@/lib/errors";
import { assertExpectedNetwork } from "@/thruput/client";
import {
  createTransactionObserver,
  executionFailure,
  receiptResult,
} from "./transaction-observation";
import type { WriteBoundary, WriteResult } from "./write-boundary";
import { walletFailure } from "./wallet-error";

export function createProviderWriteBoundary(
  config: AppConfig,
  client: CoreThruputClient,
  wallet?: ProviderWalletClient,
): WriteBoundary {
  const observe = createTransactionObserver(config, client);
  return {
    observe,
    async supportsBatch(count) {
      if (!wallet) return false;
      const capabilities = await wallet.getCapabilities();
      return (capabilities.atomicBatch?.maxCalls ?? 0) >= count;
    },
    execute: (call, observer) => executeCalls([call], observer, false),
    executeBatch: (calls, observer) => executeCalls(calls, observer, true),
  };
  async function executeCalls(
    calls: readonly ContractCall[],
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
      await assertExpectedNetwork(client, config.networkIdHex);
      const targets = calls.map((call) => call.invocation);
      const createsToken = targets.some(
        (target) =>
          bytesEqual(target.invoked_address, config.factoryAddress) &&
          bytesEqual(
            target.entrypoint,
            StandardTokenFactory.v0_1.createToken.entrypoint,
          ),
      );
      const contractsToDeploy = createsToken
        ? [await loadStandardTokenArtifact(config.expectedTokenHash)]
        : undefined;
      const preparation = {
        gasLimit: gasAmount(
          batched
            ? walletGasLimit(targets, gasAmount(2_000_000n))
            : 10_000_000n,
        ),
        expiryBlocks: 1_000n,
        ...(contractsToDeploy ? { contractsToDeploy } : {}),
      };
      const result = await wallet.executeCallsAndWait(
        { ...preparation, calls },
        {
          onSigned: ({ hash }) => observer.onSigned(hash),
          wait: { timeoutMs: 20_000, pollingIntervalMs: 500 },
        },
      );
      return receiptResult(result.receipt);
    } catch (error) {
      const result = executionFailure(error);
      if (result) return result;
      const failure = walletFailure(error);
      return {
        kind: "preSubmissionFailure",
        hash: null,
        message:
          failure.message ??
          userErrorMessage(
            error,
            "The wallet transaction could not be prepared",
          ),
      };
    }
  }
}
