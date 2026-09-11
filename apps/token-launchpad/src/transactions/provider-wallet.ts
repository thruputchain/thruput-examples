import {
  bytesEqual,
  fromHex0x,
  type GroundhogClient,
} from "@groundhogchain/client";
import { DefaultWallet } from "@groundhogchain/client/contracts";
import {
  type WalletAccount,
  type WalletProvider,
} from "@groundhogchain/client/provider";
import { createProviderWalletClient } from "@groundhogchain/client/wallet";
import { gasAmount, sha256Hash } from "@groundhogchain/protocol";
import type { AppConfig } from "@/config";
import { StandardTokenFactory } from "@/contracts/generated/standard-token-factory";
import { loadStandardTokenArtifact } from "@/contracts/token-artifact";
import { userErrorMessage } from "@/errors";
import { assertExpectedNetwork } from "@/groundhog/client";
import { outcomeFromReceipt, outcomeFromStatus } from "@/transactions/outcome";
import type { WriteBoundary, WriteResult } from "@/transactions/write-boundary";

export function createProviderWriteBoundary(
  config: AppConfig,
  client: GroundhogClient,
  provider: WalletProvider,
  account: WalletAccount,
): WriteBoundary & { dispose(): void } {
  const wallet = createProviderWalletClient({
    client,
    provider,
    account,
    networkHash: config.networkIdHex,
  });
  const observe = createTransactionObserver(config, client);
  return {
    dispose: () => wallet.dispose(),
    observe,
    async execute(target, observer) {
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
        // Persistence is part of the pre-broadcast boundary, including async stores.
        await observer.onSigned(signed.hash);
      } catch (error) {
        return {
          kind: "preSubmissionFailure",
          hash: null,
          message: userErrorMessage(
            error,
            "The wallet transaction could not be prepared",
          ),
        };
      }
      try {
        await wallet.submitTransaction(signed);
      } catch {
        const result = await observe(signed.hash);
        return result.kind === "indeterminate" && result.reason === "timeout"
          ? { kind: "indeterminate", hash: signed.hash, reason: "disconnect" }
          : result;
      }
      return observe(signed.hash);
    },
  };
}

// Observation uses only public RPC and remains usable after the wallet is disposed.
export function createTransactionObserver(
  config: Pick<AppConfig, "networkIdHex">,
  client: GroundhogClient,
  options: { maxPolls?: number; delay?: () => Promise<void> } = {},
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
