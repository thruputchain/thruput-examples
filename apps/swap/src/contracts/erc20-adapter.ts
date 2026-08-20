import type { ContractView, GroundhogClient } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import { ERC20, ERC20Metadata } from "@/contracts/generated/erc20";

export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
}

export interface TokenMetadataViews {
  name: ContractView<string | null>;
  symbol: ContractView<string | null>;
  decimals: ContractView<number | null>;
}

export interface Erc20ReadAdapter {
  balanceOf(owner: ContractAddress): Promise<ContractView<bigint>>;
  allowance(
    owner: ContractAddress,
    spender: ContractAddress,
  ): Promise<ContractView<bigint>>;
  metadata(): Promise<TokenMetadataViews>;
}

export function createErc20ReadAdapter(params: {
  client: Pick<GroundhogClient, "view">;
  contract: ContractAddress;
  caller: ContractAddress;
}): Erc20ReadAdapter {
  return {
    balanceOf(owner) {
      return ERC20.getBalanceOf.view({
        client: params.client,
        contract: params.contract,
        caller: params.caller,
        args: { addr: owner },
      });
    },
    allowance(owner, spender) {
      return ERC20.allowance.view({
        client: params.client,
        contract: params.contract,
        caller: params.caller,
        args: { owner, spender },
      });
    },
    async metadata() {
      const [name, symbol, decimals] = await Promise.all([
        ERC20Metadata.name.view({
          client: params.client,
          contract: params.contract,
          caller: params.caller,
        }),
        ERC20Metadata.symbol.view({
          client: params.client,
          contract: params.contract,
          caller: params.caller,
        }),
        ERC20Metadata.decimals.view({
          client: params.client,
          contract: params.contract,
          caller: params.caller,
        }),
      ]);
      return {
        name,
        symbol,
        decimals: { ...decimals, value: optionalDecimals(decimals.value) },
      };
    },
  };
}

function optionalDecimals(value: bigint | null): number | null {
  if (value === null) return null;
  if (value < 0n || value > 255n) {
    throw new RangeError("Token decimals are outside the supported range");
  }
  return Number(value);
}
