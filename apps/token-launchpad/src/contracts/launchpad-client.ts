import {
  bytesEqual,
  fixedBytes,
  toHex0x,
  type CoreThruputClient,
} from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";
import { getContract } from "@thruputchain/client/contract";

import type { AppConfig } from "@/config";
import {
  StandardTokenFactory,
  standard_token_factory_if,
} from "@/contracts/generated/standard-token-factory";
import { ERC20 } from "@/contracts/generated/standard-token";
import { MAX_SIGNED_AMOUNT } from "../../shared/amount";

type FactoryConfig = standard_token_factory_if.v0_1.factory.FactoryConfig;

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
  client: CoreThruputClient,
  config: AppConfig,
  nonce: Uint8Array,
  options: { balanceItemKnown?: boolean } = {},
): Promise<FactoryReview> {
  const factoryContract = getContract({
    binding: StandardTokenFactory.v0_1,
    address: config.factoryAddress,
    client,
  });
  const nativeToken = getContract({
    binding: ERC20.v0_1,
    address: config.nativeHogAddress,
    client,
  });
  const caller = config.accountAddress;
  const factory = (await factoryContract.config.view({ caller })).value;
  assertTrustedFactoryConfig(factory, config);
  const predictedAddress = (
    await factoryContract.predictToken.view({
      caller,
      args: { creator: config.accountAddress, nonce: fixedBytes(nonce, 32) },
    })
  ).value;
  const [reserveResult, creatorResult] = await Promise.all([
    nativeToken.getBalanceOf.view({
      caller,
      args: { addr: predictedAddress },
    }),
    nativeToken.getBalanceOf.view({
      caller,
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
