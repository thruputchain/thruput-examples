import { bytesEqual, type GroundhogClient } from "@groundhogchain/client";
import type { ProviderWalletClient } from "@groundhogchain/client/wallet";
import { gasAmount } from "@groundhogchain/protocol";
import type { AppConfig } from "@/config";
import { StandardTokenFactory } from "@/contracts/generated/standard-token-factory";
import { loadStandardTokenArtifact } from "@/contracts/token-artifact";
import { userErrorMessage } from "@/errors";
import { assertExpectedNetwork } from "@/groundhog/client";
import { createTransactionObserver } from "./transaction-observation";
import type { WriteBoundary } from "./write-boundary";
import { walletFailure } from "./wallet-error";

export function createProviderWriteBoundary(
  config: AppConfig,
  client: GroundhogClient,
  wallet?: ProviderWalletClient,
  onConnectionLost?: () => void,
): WriteBoundary & { dispose(): void } {
  const observe = createTransactionObserver(config, client);
  return {
    dispose: () => wallet?.dispose(),
    observe,
    async execute(target, observer) {
      if (!wallet)
        return {
          kind: "preSubmissionFailure",
          hash: null,
          message: "Connect a wallet to make changes",
        };
      let signed;
      try {
        await assertExpectedNetwork(client, config.networkIdHex);
        const createsToken =
          bytesEqual(target.invoked_address, config.factoryAddress) &&
          bytesEqual(
            target.entrypoint,
            StandardTokenFactory.createToken.entrypoint,
          );
        const contractsToDeploy = createsToken
          ? [await loadStandardTokenArtifact(config.expectedTokenHash)]
          : undefined;
        const transaction = await wallet.prepareExecution({
          invocation: target,
          gasLimit: gasAmount(10_000_000n),
          expiryBlocks: 1_000n,
          ...(contractsToDeploy ? { contractsToDeploy } : {}),
        });
        signed = await wallet.signTransaction(transaction);
        // Storage must succeed before broadcasting these exact approved bytes.
        await observer.onSigned(signed.hash);
      } catch (error) {
        const failure = walletFailure(error);
        if (failure.reason === "connectionLost") onConnectionLost?.();
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
      } catch (error) {
        if (walletFailure(error).reason === "connectionLost")
          onConnectionLost?.();
        const result = await observe(signed.hash);
        return result.kind === "indeterminate" && result.reason === "timeout"
          ? { ...result, reason: "disconnect" }
          : result;
      }
      return observe(signed.hash);
    },
  };
}
