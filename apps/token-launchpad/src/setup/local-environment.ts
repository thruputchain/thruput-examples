import { toHex0x } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import { PINNED_NATIVE_BALANCE_ITEM_COST } from "../runtime";

export const REQUIRED_TOKEN_FUNDING = 350_770n;
export const EXPECTED_BALANCE_COST = PINNED_NATIVE_BALANCE_ITEM_COST.toString();

export interface RuntimeManifest {
  schemaVersion: number;
  kind: string;
  chainState: string;
  networkHash: string;
  producer: { binary: string; version: string; commitHash: string };
  bootstrapAccountDerivation: { scheme: string; seed: string };
  bootstrapAccounts: Array<{
    index: number;
    role: "faucet" | "local_user";
    publicKey: string;
    walletAddress: string;
  }>;
  bootstrap: {
    devWallet: { deployEntrypoint: string; doActionEntrypoint: string };
    storageCostModel: {
      hash: string;
      baseDataItemCost: string;
      bytestringCostPerByte: string;
      baseContractDeploymentCost: string;
      contractDeploymentCostPerByte: string;
      authPerKeyCost: string;
      rcqCostPerEntry: string;
      replayCacheCostPerEntry: string;
      balanceCost: string;
    };
  };
}

export interface EnvironmentPersona {
  id: "alice" | "bob" | "carol";
  label: "Alice" | "Bob" | "Carol";
  accountAddress: string;
  privateKey: string;
}

export function validateRuntimeManifest(manifest: RuntimeManifest): void {
  const costs = manifest.bootstrap.storageCostModel;
  if (
    manifest.schemaVersion !== 2 ||
    manifest.kind !== "hogd-dev-runtime" ||
    manifest.chainState !== "fresh" ||
    manifest.producer.binary !== "hog-devnode" ||
    manifest.producer.version !== "0.1.25-rc.1" ||
    manifest.producer.commitHash.length === 0 ||
    manifest.bootstrapAccountDerivation.scheme !==
      "groundhog-bootstrap-account-v1" ||
    costs.hash !==
      "0x7fcd5d27353800caf9f8f3a73a030be49a1dcd9db4616792e7887746bea713ce" ||
    costs.baseDataItemCost !== "12000" ||
    costs.bytestringCostPerByte !== "10" ||
    costs.baseContractDeploymentCost !== "12000" ||
    costs.contractDeploymentCostPerByte !== "10" ||
    costs.authPerKeyCost !== "1111" ||
    costs.rcqCostPerEntry !== "8" ||
    costs.replayCacheCostPerEntry !== "7" ||
    costs.balanceCost !== EXPECTED_BALANCE_COST
  ) {
    throw new Error(
      "The runtime manifest does not match the pinned local runtime",
    );
  }
  const users = manifest.bootstrapAccounts.filter(
    ({ role }) => role === "local_user",
  );
  if (users.length < 3) {
    throw new Error(
      "The local node must provide Alice, Bob, and Carol accounts",
    );
  }
}

export function renderEnvironment(input: {
  rpcUrl: string;
  networkHash: string;
  walletEntrypoint: string;
  nativeHogAddress: ContractAddress;
  factoryAddress: ContractAddress;
  tokenHash: Uint8Array;
  personas: EnvironmentPersona[];
}): string {
  return [
    `VITE_GROUNDHOG_RPC_URL=${input.rpcUrl}`,
    `VITE_GROUNDHOG_NETWORK_ID=${input.networkHash}`,
    `GROUNDHOG_DEV_PERSONAS=${JSON.stringify(input.personas)}`,
    `VITE_GROUNDHOG_WALLET_ADDRESS=${input.personas[0]!.accountAddress}`,
    `VITE_GROUNDHOG_WALLET_ENTRYPOINT=${input.walletEntrypoint}`,
    `VITE_NATIVE_HOG_ADDRESS=${toHex0x(input.nativeHogAddress)}`,
    `VITE_NATIVE_BALANCE_ITEM_COST=${EXPECTED_BALANCE_COST}`,
    `VITE_STANDARD_TOKEN_FACTORY_ADDRESS=${toHex0x(input.factoryAddress)}`,
    `VITE_STANDARD_TOKEN_HASH=${toHex0x(input.tokenHash)}`,
    "",
  ].join("\n");
}
