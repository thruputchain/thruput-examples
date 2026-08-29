import {
  bytesEqual,
  fixedBytes,
  toHex0x,
  type GroundhogClient,
} from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import type { AppConfig } from "@/config";
import {
  StandardTokenFactory,
  TokenCreated,
  type FactoryConfig,
} from "@/contracts/generated/standard-token-factory";
import { ERC20, ERC20Metadata } from "@/contracts/generated/standard-token";
import { MAX_SIGNED_AMOUNT } from "@/runtime";

export interface FactoryReview {
  config: FactoryConfig;
  predictedAddress: ContractAddress;
  predictedAddressHex: string;
  currentReserve: bigint;
  fundingAmount: bigint;
  creatorBalance: bigint;
  fundingShortfall: bigint;
}
export interface CreatedToken {
  addressHex: string;
  name: string;
  symbol: string;
  decimals: number | null;
  initialSupply: bigint;
  balance: bigint | null;
  administratorHex: string;
  holderHex: string;
  block: bigint;
  transactionHash: string;
  readError: boolean;
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
  client: GroundhogClient,
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
    fundingAmount,
    creatorBalance,
    fundingShortfall:
      fundingAmount > creatorBalance ? fundingAmount - creatorBalance : 0n,
  };
}

export async function readCreatedTokens(
  client: GroundhogClient,
  config: AppConfig,
  options: { creator?: ContractAddress | null } = {},
): Promise<{
  tokens: CreatedToken[];
  truncated: boolean;
  historyLimited: boolean;
}> {
  const creator =
    options.creator === undefined ? config.accountAddress : options.creator;
  const page = await client.getEvents({
    filters: [
      TokenCreated.filter({
        contractAddresses: [config.factoryAddress],
        ...(creator === null ? {} : { topics: { creator } }),
      }),
    ],
    order: "descending",
    anchor: "end",
    limit: 101,
  });
  const events = page.events.slice(0, 100);
  const tokens: CreatedToken[] = [];
  for (let offset = 0; offset < events.length; offset += 10) {
    tokens.push(
      ...(await Promise.all(
        events.slice(offset, offset + 10).map(async (item) => {
          const event = TokenCreated.decode(item.event);
          if (event === null)
            throw new Error(
              "Factory history contained an invalid TokenCreated event",
            );
          let name = event.fields.name ?? "Unnamed token";
          let symbol = event.fields.symbol ?? "TOKEN";
          let decimals = safeDisplayDecimals(event.fields.decimals);
          let balance: bigint | null = null;
          let readError = false;
          try {
            const [
              currentName,
              currentSymbol,
              currentDecimals,
              currentBalance,
            ] = await Promise.all([
              ERC20Metadata.name.view({
                client,
                contract: event.topics.token,
                caller: config.accountAddress,
              }),
              ERC20Metadata.symbol.view({
                client,
                contract: event.topics.token,
                caller: config.accountAddress,
              }),
              ERC20Metadata.decimals.view({
                client,
                contract: event.topics.token,
                caller: config.accountAddress,
              }),
              ERC20.getBalanceOf.view({
                client,
                contract: event.topics.token,
                caller: config.accountAddress,
                args: { addr: config.accountAddress },
              }),
            ]);
            name = currentName.value ?? name;
            symbol = currentSymbol.value ?? symbol;
            if (currentDecimals.value !== null) {
              decimals = safeDisplayDecimals(currentDecimals.value);
              if (decimals === null) readError = true;
            }
            balance = currentBalance.value;
          } catch {
            readError = true;
          }
          return {
            addressHex: toHex0x(event.topics.token),
            name,
            symbol,
            decimals,
            initialSupply: event.fields.initial_supply,
            balance,
            administratorHex: toHex0x(event.fields.administrator),
            holderHex: toHex0x(event.fields.initial_holder),
            block: item.blockHeight,
            transactionHash: toHex0x(item.txHash),
            readError,
          };
        }),
      )),
    );
  }
  return {
    tokens,
    truncated: page.events.length > 100 || page.cursor.length > 0,
    historyLimited: page.oldestBlock > 1n,
  };
}
