import { bytesEqual, type CoreGroundhogClient } from "@groundhogchain/client";
import type { ProviderWalletClient } from "@groundhogchain/client/wallet";
import { gasAmount, type Invocation } from "@groundhogchain/protocol";
import type { AppConfig } from "@/config";
import { StandardTokenFactory } from "@/contracts/generated/standard-token-factory";
import { loadStandardTokenArtifact } from "@/contracts/token-artifact";
import { userErrorMessage } from "@/lib/errors";
import { assertExpectedNetwork } from "@/groundhog/client";
import { createTransactionObserver } from "./transaction-observation";
import type { WriteBoundary, WriteResult } from "./write-boundary";
import { walletFailure } from "./wallet-error";

export function createProviderWriteBoundary(
  config: AppConfig,
  client: CoreGroundhogClient,
  wallet?: ProviderWalletClient,
): WriteBoundary {
  const observe = createTransactionObserver(config, client);
  const observeBatch = createTransactionObserver(config, client, {
    preserveWalletReturns: true,
  });
  return {
    observe,
    observeBatch,
    async supportsBatch(count) {
      if (!wallet) return false;
      const capabilities = await wallet.getCapabilities();
      return (capabilities.atomicBatch?.maxCalls ?? 0) >= count;
    },
    execute: (target, observer) => executeTargets([target], observer, false),
    executeBatch: (targets, observer) =>
      executeTargets(targets, observer, true),
  };
  async function executeTargets(
    targets: readonly Invocation[],
    observer: Parameters<WriteBoundary["execute"]>[1],
    batched: boolean,
  ): Promise<WriteResult> {
    const observeTransaction = batched ? observeBatch : observe;
    if (!wallet)
      return {
        kind: "preSubmissionFailure",
        hash: null,
        message: "Connect a wallet to make changes",
      };
    let signed;
    try {
      await assertExpectedNetwork(client, config.networkIdHex);
      const createsToken = targets.some(
        (target) =>
          bytesEqual(target.invoked_address, config.factoryAddress) &&
          bytesEqual(
            target.entrypoint,
            StandardTokenFactory.createToken.entrypoint,
          ),
      );
      const contractsToDeploy = createsToken
        ? [await loadStandardTokenArtifact(config.expectedTokenHash)]
        : undefined;
      const preparation = {
        gasLimit: gasAmount(
          batched
            ? targets.reduce(
                (total, target) => total + target.gas_limit,
                2_000_000n,
              )
            : 10_000_000n,
        ),
        expiryBlocks: 1_000n,
        ...(contractsToDeploy ? { contractsToDeploy } : {}),
      };
      const transaction = batched
        ? await wallet.prepareBatchExecution({
            ...preparation,
            invocations: targets,
          })
        : await wallet.prepareExecution({
            ...preparation,
            invocation: targets[0]!,
          });
      signed = await wallet.signTransaction(transaction);
      // Storage must succeed before broadcasting these exact approved bytes.
      await observer.onSigned(signed.hash);
    } catch (error) {
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
    try {
      await wallet.submitTransaction(signed);
    } catch {
      const result = await observeTransaction(signed.hash);
      return result.kind === "indeterminate" && result.reason === "timeout"
        ? { ...result, reason: "disconnect" }
        : result;
    }
    return observeTransaction(signed.hash);
  }
}
