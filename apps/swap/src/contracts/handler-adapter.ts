import type { ContractView, GroundhogClient } from "@groundhogchain/client";
import type { ContractAddress } from "@groundhogchain/protocol";
import { CxsWriter } from "@groundhogchain/xdr";

import {
  SwapHandler,
  type U256,
} from "./generated/swap-handler";

export interface PoolState {
  reserve0: bigint;
  reserve1: bigint;
  blockTimestamp: bigint;
  liquidity: bigint;
  liquidityToken: ContractAddress;
  cumulativePrices: readonly [U256, U256];
}

export interface SwapHandlerReadAdapter {
  poolState(): Promise<ContractView<PoolState>>;
}

export function createSwapHandlerReadAdapter(params: {
  client: Pick<GroundhogClient, "view">;
  contract: ContractAddress;
  caller: ContractAddress;
}): SwapHandlerReadAdapter {
  const compatibleClient: Pick<GroundhogClient, "view"> = {
    async view(request) {
      const response = await params.client.view(request);
      if (response.output.result !== "return") return response;

      return {
        ...response,
        output: {
          ...response.output,
          returnData: normalizePoolStateU256(response.output.returnData),
        },
      };
    },
  };

  return {
    async poolState() {
      const result = await SwapHandler.poolState.view({
        client: compatibleClient,
        contract: params.contract,
        caller: params.caller,
      });
      const [reserve0, reserve1] = result.value.reserves;
      return {
        ...result,
        value: {
          reserve0,
          reserve1,
          blockTimestamp: result.value.block_timestamp,
          liquidity: result.value.liquidity,
          liquidityToken: result.value.liquidity_token,
          cumulativePrices: result.value.cumulative_prices,
        },
      };
    },
  };
}

function normalizePoolStateU256(data: Uint8Array): Uint8Array {
  const cumulativePriceBytes = 64;
  if (data.length < cumulativePriceBytes) {
    throw new Error("Handler pool state is missing cumulative-price data");
  }

  // TODO: Remove this compatibility shim once groundhog-u256's fixed 32-byte
  // runtime encoding matches its advertised [u32; 8] CXS contract spec.
  const prefixLength = data.length - cumulativePriceBytes;
  const limbs = new CxsWriter();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = prefixLength; offset < data.length; offset += 4) {
    limbs.writeUint32(BigInt(view.getUint32(offset, false)));
  }
  const encodedLimbs = limbs.finish();
  const normalized = new Uint8Array(prefixLength + encodedLimbs.length);
  normalized.set(data.subarray(0, prefixLength));
  normalized.set(encodedLimbs, prefixLength);
  return normalized;
}
