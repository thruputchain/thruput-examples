import {
  bytesEqual,
  fixedBytes,
  toHex0x,
  type CoreGroundhogClient,
} from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import type { AppConfig } from "@/config";
import {
  StandardTokenFactory,
  type FactoryConfig,
} from "@/contracts/generated/standard-token-factory";
import { ERC20 } from "@/contracts/generated/standard-token";
import { MAX_SIGNED_AMOUNT } from "@/runtime";

export interface FactoryReview {
  config: FactoryConfig;
  predictedAddress: ContractAddress;
  predictedAddressHex: string;
  currentReserve: bigint;
  reserveHeight: bigint;
  fundingAmount: bigint;
  creatorBalance: bigint;
  fundingShortfall: bigint;
}

export function assertTrustedFactoryConfig(
  factory: FactoryConfig,
  config: AppConfig,
): void {
  if (
    !bytesEqual(factory.native_token, config.nativeHogAddress) ||
    !bytesEqual(factory.token_code_hash, config.expectedTokenHash) ||
    factory.required_token_funding <= 0n ||
    factory.required_token_funding > MAX_SIGNED_AMOUNT ||
    factory.creation_fee !== 0n ||
    factory.fee_recipient !== null
  ) {
    throw new Error("The configured token factory could not be verified.");
  }
}

export function calculateFundingAmount(
  required: bigint,
  current: bigint,
  balanceItemCost: bigint,
  balanceItemKnown: boolean,
): bigint {
  const deficit = required > current ? required - current : 0n;
  const amount =
    deficit === 0n
      ? 0n
      : deficit + (current === 0n && !balanceItemKnown ? balanceItemCost : 0n);
  if (amount > MAX_SIGNED_AMOUNT) {
    throw new Error(
      "The factory funding requirement exceeds the amount limit.",
    );
  }
  return amount;
}

export function safeDisplayDecimals(value: bigint | null): number | null {
  return value !== null && value >= 0n && value <= 18n ? Number(value) : null;
}

export async function reviewFactory(
  client: CoreGroundhogClient,
  config: AppConfig,
  nonce: Uint8Array,
  options: { balanceItemKnown?: boolean } = {},
): Promise<FactoryReview> {
  const factory = (
    await StandardTokenFactory.config.view({
      client,
      contract: config.factoryAddress,
      caller: config.accountAddress,
    })
  ).value;
  assertTrustedFactoryConfig(factory, config);
  const predictedAddress = (
    await StandardTokenFactory.predictToken.view({
      client,
      contract: config.factoryAddress,
      caller: config.accountAddress,
      args: { creator: config.accountAddress, nonce: fixedBytes(nonce, 32) },
    })
  ).value;
  const [reserveResult, creatorResult] = await Promise.all([
    ERC20.getBalanceOf.view({
      client,
      contract: config.nativeHogAddress,
      caller: config.accountAddress,
      args: { addr: predictedAddress },
    }),
    ERC20.getBalanceOf.view({
      client,
      contract: config.nativeHogAddress,
      caller: config.accountAddress,
      args: { addr: config.accountAddress },
    }),
  ]);
  const currentReserve = reserveResult.value;
  const creatorBalance = creatorResult.value;
  const fundingAmount = calculateFundingAmount(
    factory.required_token_funding,
    currentReserve,
    config.nativeBalanceItemCost,
    options.balanceItemKnown ?? false,
  );
  return {
    config: factory,
    predictedAddress,
    predictedAddressHex: toHex0x(predictedAddress),
    currentReserve,
    reserveHeight: reserveResult.height,
    fundingAmount,
    creatorBalance,
    fundingShortfall:
      fundingAmount > creatorBalance ? fundingAmount - creatorBalance : 0n,
  };
}
