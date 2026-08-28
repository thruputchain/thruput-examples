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

export interface FactoryReview {
  config: FactoryConfig;
  predictedAddress: ContractAddress;
  predictedAddressHex: string;
  currentReserve: bigint;
  fundingAmount: bigint;
}
export interface CreatedToken {
  addressHex: string;
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: bigint;
  balance: bigint | null;
  administratorHex: string;
  holderHex: string;
  block: bigint;
  transactionHash: string;
  readError: boolean;
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
  if (
    !bytesEqual(factory.native_token, config.nativeHogAddress) ||
    !bytesEqual(factory.token_code_hash, config.expectedTokenHash) ||
    factory.required_token_funding <= 0n ||
    factory.creation_fee !== 0n ||
    factory.fee_recipient !== null
  ) {
    throw new Error("The configured token factory could not be verified.");
  }
  const predictedAddress = (
    await StandardTokenFactory.predictToken.view({
      client,
      contract: config.factoryAddress,
      caller: config.accountAddress,
      args: { creator: config.accountAddress, nonce: fixedBytes(nonce, 32) },
    })
  ).value;
  const currentReserve = (
    await ERC20.getBalanceOf.view({
      client,
      contract: config.nativeHogAddress,
      caller: config.accountAddress,
      args: { addr: predictedAddress },
    })
  ).value;
  const deficit =
    factory.required_token_funding > currentReserve
      ? factory.required_token_funding - currentReserve
      : 0n;
  return {
    config: factory,
    predictedAddress,
    predictedAddressHex: toHex0x(predictedAddress),
    currentReserve,
    fundingAmount:
      deficit === 0n
        ? 0n
        : deficit +
          (currentReserve === 0n && !options.balanceItemKnown
            ? config.nativeBalanceItemCost
            : 0n),
  };
}

export async function readCreatedTokens(
  client: GroundhogClient,
  config: AppConfig,
): Promise<{
  tokens: CreatedToken[];
  truncated: boolean;
  historyLimited: boolean;
}> {
  const page = await client.getEvents({
    filters: [
      TokenCreated.filter({
        contractAddresses: [config.factoryAddress],
        topics: { creator: config.accountAddress },
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
          let decimals = Number(event.fields.decimals ?? 0n);
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
            decimals = Number(currentDecimals.value ?? BigInt(decimals));
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
