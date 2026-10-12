import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { SwapFactory } from "../../../apps/swap/src/contracts/generated/swap-factory";
import { ERC20 } from "../../../apps/swap/src/contracts/generated/erc20";
import { createSwapHandlerReadAdapter } from "../../../apps/swap/src/contracts/handler-adapter";

const require = createRequire(
  new URL("../../../apps/swap/package.json", import.meta.url),
);
const { addressFromHex, createGroundhogClient, HttpTransport, toHex0x } =
  await import(pathToFileURL(require.resolve("@groundhogchain/client")).href);
const client = await createGroundhogClient({
  transport: new HttpTransport(process.env.VITE_THRUPUT_RPC_URL!),
});
const factory = addressFromHex(process.env.VITE_SWAP_FACTORY_ADDRESS!);
const count = (
  await SwapFactory.v0_1.allPairsLength.view({ client, contract: factory })
).value;
if (process.argv[2] === "empty") {
  assert.equal(count, 0n);
  console.log(JSON.stringify({ pairs: "0" }));
} else {
  const evidence = JSON.parse(await readFile(process.argv[2]!, "utf8"));
  const caller = addressFromHex(evidence.creator);
  assert.equal(
    toHex0x((await client.getNetworkInfo()).networkHash),
    evidence.network,
  );
  assert.equal(count, 1n);
  const args = {
    tokenA: addressFromHex(evidence.token),
    tokenB: addressFromHex(evidence.counter),
  };
  const mapping = (
    await SwapFactory.v0_1.poolAddresses.view({
      client,
      caller,
      contract: factory,
      args,
    })
  ).value;
  const reverse = (
    await SwapFactory.v0_1.getPair.view({
      client,
      caller,
      contract: factory,
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
  const lp = (
    await ERC20.v0_1.getBalanceOf.view({
      client,
      caller,
      contract: mapping.liquidity_token,
      args: { addr: caller },
    })
  ).value;
  const balances = await Promise.all(
    [args.tokenA, args.tokenB].map(async (contract) =>
      (
        await ERC20.v0_1.getBalanceOf.view({
          client,
          caller,
          contract,
          args: { addr: caller },
        })
      ).value.toString(),
    ),
  );
  assert.ok(state.reserve0 > 0n && state.reserve1 > 0n && lp > 0n);
  const recipientBalances = process.argv[3]
    ? await Promise.all(
        [args.tokenA, args.tokenB].map(async (contract) =>
          (
            await ERC20.v0_1.getBalanceOf.view({
              client,
              caller,
              contract,
              args: { addr: addressFromHex(process.argv[3]!) },
            })
          ).value.toString(),
        ),
      )
    : undefined;
  console.log(
    JSON.stringify({
      reserve0: state.reserve0.toString(),
      reserve1: state.reserve1.toString(),
      lp: lp.toString(),
      balances,
      ...(recipientBalances ? { recipientBalances } : {}),
    }),
  );
}
