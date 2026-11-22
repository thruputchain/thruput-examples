// Explicit live check: npm run test:swap-users (generate Swap bindings first).
// Three users share one pool on a managed testkit node: Alice provides
// liquidity, Bob swaps, and Carol's two requests fail as expected. CI runs this
// multi-user companion to tests/e2e/swap.ts, which checks one pool in depth.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  gasAmount,
  isThruputError,
  type ContractAddress,
} from "@thruputchain/client";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { loadArtifacts, withLocalScenario } from "@thruputchain/testkit";
import { provisionSwap } from "../../apps/swap/scripts/index";
import { ERC20 } from "../../apps/swap/src/contracts/generated/erc20";
import { SwapFactory } from "../../apps/swap/src/contracts/generated/swap-factory";
import { SwapRouter } from "../../apps/swap/src/contracts/generated/swap-router";
import {
  SwapHandler,
  spec as handlerSpec,
} from "../../apps/swap/src/contracts/generated/swap-handler";
import {
  SwapDriver,
  batch_driver,
} from "../../apps/swap/src/contracts/generated/swap-driver";
import { CRANK_FRAME_GAS } from "../../apps/swap/src/contracts/driver-target";

const root = fileURLToPath(new URL("../..", import.meta.url));
const gasLimit = gasAmount(10_000_000n);
const supply = 10_000_000_000n;
const liquidity = 1_000_000_000n;
const amountIn = 1_000_000n;
// Constant-product output with the contract's 0.3% fee, calculated independently.
const out = (input: bigint, reserveIn: bigint, reserveOut: bigint) =>
  (input * 997n * reserveOut) / (reserveIn * 1000n + input * 997n);

test(
  "users share a pool: liquidity, a swap, and expected failures",
  { timeout: 300_000 },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "swap-users-"));
    try {
      await withLocalScenario(
        {
          seed: "swap-users",
          // Genesis funding for each user, so users need no faucet.
          accounts: {
            alice: { initialStorageTokens: 1_000_000_000n },
            bob: { initialStorageTokens: 1_000_000_000n },
            carol: { initialStorageTokens: 1_000_000_000n },
          },
        },
        async (scenario) => {
          // Deploy the app's infrastructure with its real setup script.
          const { factory, router } = await provisionSwap({
            network: "local",
            rpcUrl: scenario.local.rpcUrl,
            output: join(work, ".env.local"),
            publicDirectory: join(work, "public"),
          });
          const alice = scenario.actor("alice");
          const bob = scenario.actor("bob");
          const carol = scenario.actor("carol");
          const { erc20 } = await loadArtifacts({
            erc20: join(root, "target/thruput/erc20.rv32a"),
          });
          const balance = async (
            token: ContractAddress,
            owner: ContractAddress,
          ) =>
            (
              await scenario.view(
                ERC20.v0_1.getBalanceOf.viewRequest({
                  address: token,
                  args: { addr: owner },
                }),
              )
            ).value;

          // Alice deploys two tokens and mints to every user.
          const [tokenA, tokenB] = await scenario.run.step(
            "deploy-tokens",
            async () => {
              const tokens: ContractAddress[] = [];
              for (const index of [0, 1]) {
                const deployment = erc20.prepare(alice.account.address);
                await alice.deploy(deployment, {
                  amount: 10_000_000n,
                  initializer: ERC20.v0_1.initialize.call({
                    address: deployment.address,
                    gasLimit,
                    args: { administrator: alice.account.address },
                  }),
                });
                await alice.call(
                  [alice, bob, carol].map((user) =>
                    ERC20.v0_1.mint.call({
                      address: deployment.address,
                      gasLimit,
                      args: { receiver: user.account.address, amount: supply },
                    }),
                  ),
                );
                tokens[index] = deployment.address;
              }
              return tokens as [ContractAddress, ContractAddress];
            },
          );

          // Alice creates the pool. Pair creation attaches the LP token code.
          await scenario.run.step("create-pair", () =>
            alice.call(
              [
                ERC20.v0_1.adjustAllowance.call({
                  address: NATIVE_TOKEN_ADDRESS,
                  gasLimit,
                  args: { spender: factory, difference: 30_000_000n },
                }),
                SwapFactory.v0_1.createPair.call({
                  address: factory,
                  gasLimit,
                  args: { tokenA, tokenB, funding: 10_000_000n },
                }),
              ],
              {
                contractsToDeploy: [
                  erc20.prepare(alice.account.address).contract,
                ],
              },
            ),
          );
          const pool = (
            await scenario.view(
              SwapFactory.v0_1.poolAddresses.viewRequest({
                address: factory,
                args: { tokenA, tokenB },
              }),
            )
          ).value;
          // Anyone can process queued requests. Each crank reports its results.
          const crank = async () => {
            const { receipt } = await alice.call([
              SwapDriver.v0_1.processRequests.call({
                address: pool.driver,
                gasLimit: gasAmount(CRANK_FRAME_GAS),
              }),
            ]);
            const counts =
              batch_driver.v0_1.events.RequestsProcessed.singleFromReceipt(
                receipt,
                { address: pool.driver },
              ).fields;
            return { counts, receipt };
          };
          // The handler's slippage check throws SwapRequestError.
          const requestErrorSelector = handlerSpec.interfaces[0]!.throws.find(
            ({ ty }) =>
              "named" in ty && ty.named?.declared === "SwapRequestError",
          )!.selector;
          // Swaps take input tokens from the user when the driver processes them.
          const approve = (token: ContractAddress, amount: bigint) =>
            ERC20.v0_1.adjustAllowance.call({
              address: token,
              gasLimit,
              args: { spender: pool.handler, difference: amount },
            });

          await scenario.run.step("alice-adds-liquidity", async () => {
            await alice.call([
              approve(tokenA, liquidity),
              approve(tokenB, liquidity),
              SwapRouter.v0_1.addLiquidity.call({
                address: router,
                gasLimit,
                args: {
                  tokenA,
                  tokenB,
                  amountsDesired: [liquidity, liquidity],
                  amountsMin: [liquidity, liquidity],
                  recipient: alice.account.address,
                },
              }),
            ]);
            assert.deepEqual((await crank()).counts, {
              processed: 1n,
              failed: 0n,
            });
          });
          // The first deposit locks 1,000 LP units as minimum liquidity.
          assert.equal(
            await balance(pool.liquidity_token, alice.account.address),
            liquidity - 1_000n,
          );

          const bobOut = out(amountIn, liquidity, liquidity);
          await scenario.run.step("bob-swaps", async () => {
            await bob.call([
              approve(tokenA, amountIn),
              SwapRouter.v0_1.swapExactTokensForTokens.call({
                address: router,
                gasLimit,
                args: {
                  amountIn,
                  amountOutMin: bobOut,
                  tokenIn: tokenA,
                  tokenOut: tokenB,
                  recipient: bob.account.address,
                },
              }),
            ]);
            assert.deepEqual((await crank()).counts, {
              processed: 1n,
              failed: 0n,
            });
          });
          assert.equal(
            await balance(tokenA, bob.account.address),
            supply - amountIn,
          );
          assert.equal(
            await balance(tokenB, bob.account.address),
            supply + bobOut,
          );

          // Carol asks for more output than the pool can now give. Her request is
          // accepted, and the driver records it as failed without moving her tokens.
          await scenario.run.step("carol-swap-slips", async () => {
            const reserveA = liquidity + amountIn;
            const reserveB = liquidity - bobOut;
            await carol.call([
              approve(tokenA, amountIn),
              SwapRouter.v0_1.swapExactTokensForTokens.call({
                address: router,
                gasLimit,
                args: {
                  amountIn,
                  amountOutMin: out(amountIn, reserveA, reserveB) + 1n,
                  tokenIn: tokenA,
                  tokenOut: tokenB,
                  recipient: carol.account.address,
                },
              }),
            ]);
            const { counts, receipt } = await crank();
            assert.deepEqual(counts, { processed: 1n, failed: 1n });
            const failure =
              batch_driver.v0_1.events.RequestFailed.singleFromReceipt(
                receipt,
                { address: pool.driver },
              ).fields;
            // Cause 1 is a contract exception: the handler's SwapRequestError.
            assert.equal(failure.cause, 1n);
            assert.equal(failure.selector, requestErrorSelector);
          });
          assert.equal(await balance(tokenA, carol.account.address), supply);
          assert.equal(await balance(tokenB, carol.account.address), supply);
          const { reserves } = (
            await scenario.view(
              SwapHandler.v0_1.poolState.viewRequest({ address: pool.handler }),
            )
          ).value;
          // The pool orders reserves by token address.
          const [expectedA, expectedB] = [
            liquidity + amountIn,
            liquidity - bobOut,
          ];
          assert.deepEqual(
            reserves,
            Buffer.compare(tokenA, tokenB) < 0
              ? [expectedA, expectedB]
              : [expectedB, expectedA],
          );

          // Carol tries to create the same pair, with the same funding approval
          // as Alice. Only the existing pair can make the factory abort.
          await assert.rejects(
            scenario.run.step("carol-duplicate-pair", () =>
              carol.call([
                ERC20.v0_1.adjustAllowance.call({
                  address: NATIVE_TOKEN_ADDRESS,
                  gasLimit,
                  args: { spender: factory, difference: 30_000_000n },
                }),
                SwapFactory.v0_1.createPair.call({
                  address: factory,
                  gasLimit,
                  args: { tokenA, tokenB, funding: 10_000_000n },
                }),
              ]),
            ),
            (error) => isThruputError(error, "transactionFailed"),
          );

          // The report links every user transaction to its user, step, and outcome.
          const report = scenario.run.report();
          const duplicate = report.attempts.filter(
            (attempt) => attempt.step === "carol-duplicate-pair",
          );
          assert.deepEqual(
            duplicate.map(({ actor, state, outcome }) => ({
              actor,
              state,
              outcome,
            })),
            [{ actor: "carol", state: "committed", outcome: "failed" }],
          );
          assert.equal(report.steps.at(-1)?.state, "failed");
          for (const attempt of report.attempts.filter(
            (entry) => entry.step !== "carol-duplicate-pair",
          ))
            assert.equal(attempt.outcome, "succeeded", `${attempt.step}`);
        },
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
