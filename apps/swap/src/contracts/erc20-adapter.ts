import type { GroundhogClient } from "@groundhogchain/client";
import { gasAmount, type ContractAddress } from "@groundhogchain/protocol";

import {
  ERC20,
  ERC20Metadata,
  spec,
} from "@/contracts/generated/erc20";
import { expectBigint, viewMethod } from "@/contracts/view";

const VIEW_GAS = gasAmount(10_000_000n);

export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
}

export interface Erc20ReadAdapter {
  balanceOf(owner: ContractAddress): Promise<bigint>;
  allowance(owner: ContractAddress, spender: ContractAddress): Promise<bigint>;
  metadata(): Promise<TokenMetadata>;
}

export function createErc20ReadAdapter(params: {
  client: Pick<GroundhogClient, "view">;
  contract: ContractAddress;
  caller: ContractAddress;
}): Erc20ReadAdapter {
  const read = <T>(
    invocation: ReturnType<(typeof ERC20)["getBalanceOf"]>,
    interfaceName: string,
    methodName: string,
    validate: (value: unknown) => T,
  ) =>
    viewMethod({
      client: params.client,
      invocation,
      caller: params.caller,
      spec,
      interfaceName,
      methodName,
      validate,
    });

  return {
    balanceOf(owner) {
      return read(
        ERC20.getBalanceOf(params.contract, VIEW_GAS, { addr: owner }),
        "ERC20",
        "get_balance_of",
        (value) => expectBigint(value, "ERC20.get_balance_of"),
      );
    },
    allowance(owner, spender) {
      return read(
        ERC20.allowance(params.contract, VIEW_GAS, { owner, spender }),
        "ERC20",
        "allowance",
        (value) => expectBigint(value, "ERC20.allowance"),
      );
    },
    async metadata() {
      const [name, symbol, decimals] = await Promise.all([
        read(
          ERC20Metadata.name(params.contract, VIEW_GAS),
          "ERC20Metadata",
          "name",
          optionalString,
        ),
        read(
          ERC20Metadata.symbol(params.contract, VIEW_GAS),
          "ERC20Metadata",
          "symbol",
          optionalString,
        ),
        read(
          ERC20Metadata.decimals(params.contract, VIEW_GAS),
          "ERC20Metadata",
          "decimals",
          optionalDecimals,
        ),
      ]);
      return { name, symbol, decimals };
    },
  };
}

function optionalString(value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new TypeError("Token metadata did not return a string or null");
}

function optionalDecimals(value: unknown): number | null {
  if (value === null) return null;
  const decimals = expectBigint(value, "ERC20Metadata.decimals");
  if (decimals < 0n || decimals > 255n) {
    throw new RangeError("Token decimals are outside the supported range");
  }
  return Number(decimals);
}
