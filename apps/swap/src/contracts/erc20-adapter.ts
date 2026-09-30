import type { ContractView, GroundhogClient } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";
import { getContract } from "@groundhogchain/client/contract";

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
  const token = getContract({
    binding: { ...ERC20.v0_1, ...ERC20Metadata.v0_1 },
    address: params.contract,
    client: params.client,
  });
  const caller = params.caller;
  return {
    balanceOf(owner) {
      return token.getBalanceOf.view({
        caller,
        args: { addr: owner },
      });
    },
    allowance(owner, spender) {
      return token.allowance.view({
        caller,
        args: { owner, spender },
      });
    },
    async metadata() {
      const [name, symbol, decimals] = await Promise.all([
        token.name.view({ caller }),
        token.symbol.view({ caller }),
        token.decimals.view({ caller }),
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
