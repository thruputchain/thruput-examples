import type { GroundhogClient } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";

import type { AppConfig, GlobalConfig } from "@/config";
import { createErc20ReadAdapter } from "@/contracts/erc20-adapter";
import {
  createSwapFactoryReadAdapter,
  type SwapFactoryReadAdapter,
} from "@/contracts/factory-adapter";
import { createReadClient } from "@/groundhog/client";

export class PoolNotFoundError extends Error {
  constructor() {
    super("This pool has not been created");
    this.name = "PoolNotFoundError";
  }
}

export class PoolIdentityError extends Error {
  constructor() {
    super("The factory returned inconsistent pool addresses");
    this.name = "PoolIdentityError";
  }
}

export async function resolvePoolConfig(
  config: GlobalConfig,
  token0: ContractAddress,
  token1: ContractAddress,
  suppliedFactory?: SwapFactoryReadAdapter,
  suppliedClient?: Pick<GroundhogClient, "view">,
): Promise<AppConfig> {
  const client = suppliedClient ?? createReadClient(config);
  const factory = suppliedFactory ?? createSwapFactoryReadAdapter({
    client,
    contract: config.factoryAddress,
    caller: config.accountAddress,
  });
  const token0Adapter = createErc20ReadAdapter({
    client,
    contract: token0,
    caller: config.accountAddress,
  });
  const token1Adapter = createErc20ReadAdapter({
    client,
    contract: token1,
    caller: config.accountAddress,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const registered = await factory.getPair(token0, token1);
    if (registered.value === null) throw new PoolNotFoundError();
    const addresses = await factory.poolAddresses(token0, token1);
    if (!sameAddress(registered.value, addresses.value.handler)) {
      throw new PoolIdentityError();
    }
    const [metadata0, metadata1] = await Promise.all([
      token0Adapter.metadata(),
      token1Adapter.metadata(),
    ]);
    if (metadata0.decimals.value === null || metadata1.decimals.value === null) {
      throw new Error("Pool token decimals are unavailable");
    }
    const heights = [
      registered.height,
      addresses.height,
      metadata0.name.height,
      metadata0.symbol.height,
      metadata0.decimals.height,
      metadata1.name.height,
      metadata1.symbol.height,
      metadata1.decimals.height,
    ];
    if (heights.some((height) => height !== heights[0])) continue;

    return {
      ...config,
      liquidityTokenAddress: addresses.value.liquidityToken,
      handlerAddress: addresses.value.handler,
      driverAddress: addresses.value.driver,
      tokenAAddress: token0,
      tokenBAddress: token1,
      tokenASymbol: metadata0.symbol.value?.trim() || "Token A",
      tokenBSymbol: metadata1.symbol.value?.trim() || "Token B",
      tokenADecimals: metadata0.decimals.value,
      tokenBDecimals: metadata1.decimals.value,
    };
  }
  throw new Error("Unable to resolve a consistent pool snapshot after three attempts");
}

function sameAddress(left: ContractAddress, right: ContractAddress): boolean {
  return left.every((byte, index) => byte === right[index]);
}
