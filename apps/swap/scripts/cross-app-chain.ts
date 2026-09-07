import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  addressFromHex,
  createGroundhogClient,
  HttpTransport,
  toHex0x,
} from "@groundhogchain/client";
import { SwapFactory } from "../src/contracts/generated/swap-factory";
import { ERC20 } from "../src/contracts/generated/erc20";
import { createSwapHandlerReadAdapter } from "../src/contracts/handler-adapter";

const evidence = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const client = await createGroundhogClient({
  transport: new HttpTransport(process.env.VITE_GROUNDHOG_RPC_URL!),
});
const network = await client.getNetworkInfo();
assert.equal(
  toHex0x(network.networkHash).slice(2),
  evidence.network.replace(/^0x/, ""),
);
const caller = addressFromHex(evidence.creator);
const contract = addressFromHex(process.env.VITE_SWAP_FACTORY_ADDRESS!);
const args = {
  tokenA: addressFromHex(evidence.token),
  tokenB: addressFromHex(evidence.counter),
};
const mapping = (
  await SwapFactory.poolAddresses.view({ client, caller, contract, args })
).value;
const reverse = (
  await SwapFactory.getPair.view({
    client,
    caller,
    contract,
    args: { tokenA: args.tokenB, tokenB: args.tokenA },
  })
).value;
assert.ok(reverse);
assert.equal(toHex0x(reverse), evidence.pool.handler);
assert.equal(toHex0x(mapping.handler), evidence.pool.handler);
assert.equal(toHex0x(mapping.driver), evidence.pool.driver);
assert.equal(toHex0x(mapping.liquidity_token), evidence.pool.liquidityToken);
const state = (
  await createSwapHandlerReadAdapter({
    client,
    caller,
    contract: mapping.handler,
  }).poolState()
).value;
assert.equal(state.reserve0, 10_000_000n);
assert.equal(state.reserve1, 10_000_000n);
const lp = (
  await ERC20.getBalanceOf.view({
    client,
    caller,
    contract: mapping.liquidity_token,
    args: { addr: caller },
  })
).value;
assert.ok(lp > 0n);
console.log(
  `PASS live canonical mapping + reverse getPair; reserves=${state.reserve0},${state.reserve1}; LP=${lp}; handler=${evidence.pool.handler}; liquidityToken=${evidence.pool.liquidityToken}`,
);
