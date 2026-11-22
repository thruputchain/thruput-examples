import { useState, type FormEvent } from "react";
import type { ContractAddress } from "@thruputchain/protocol";
import type { AppConfig } from "@/config";
import {
  addLiquidityRequest,
  approve,
  readAllowance,
  removeLiquidityRequest,
  type Pool,
  type PoolState,
  type Reader,
} from "@/contracts/swap";
import { formatAmount, parseAmount } from "@/domain/amount";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { useQueuedRequest } from "@/transactions/use-queued-request";

/** How far the price may move before a queued request is processed: 1%. */
export const SLIPPAGE_BPS = 100n;

const withSlippage = (amount: bigint) =>
  (amount * (10_000n - SLIPPAGE_BPS)) / 10_000n;

interface FormProps {
  config: AppConfig;
  reader: Reader;
  account: ContractAddress;
  pool: Pool;
  state: PoolState;
  request: ReturnType<typeof useQueuedRequest>;
}

/** Approve the exact allowance a request still needs, if any. */
async function approvalIfNeeded(
  reader: Reader,
  token: ContractAddress,
  spender: ContractAddress,
  amount: bigint,
) {
  const allowance = await readAllowance(reader, token, spender);
  return allowance < amount ? [approve(token, spender, amount - allowance)] : [];
}

/**
 * Add both tokens in the pool's current ratio. You choose the first amount;
 * the second follows from the reserves.
 */
export function AddLiquidityForm(props: FormProps) {
  const { config, reader, account, pool, state, request } = props;
  const [amount, setAmount] = useState("");
  const [reserve0, reserve1] = state.reserves;
  const parsed = parseAmount(amount, pool.token0.decimals);
  const amount0 = parsed.ok ? parsed.value : 0n;
  const amount1 = reserve0 > 0n ? (amount0 * reserve1) / reserve0 : 0n;
  const problem =
    amount && !parsed.ok
      ? "Enter a valid amount."
      : reserve0 === 0n
        ? "This pool has no liquidity yet."
        : amount0 > state.balances[0]
          ? `Not enough ${pool.token0.symbol}.`
          : amount1 > state.balances[1]
            ? `Not enough ${pool.token1.symbol}.`
            : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (amount0 === 0n || amount1 === 0n || problem) return;
    await request.submit("Add liquidity", pool, [
      ...(await approvalIfNeeded(reader, pool.token0.address, pool.handler, amount0)),
      ...(await approvalIfNeeded(reader, pool.token1.address, pool.handler, amount1)),
      addLiquidityRequest(config.routerAddress, {
        tokenA: pool.token0.address,
        tokenB: pool.token1.address,
        amountsDesired: [amount0, amount1],
        amountsMin: [withSlippage(amount0), withSlippage(amount1)],
        recipient: account,
      }),
    ]);
    setAmount("");
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <Field>
        <FieldLabel htmlFor="add-amount">{pool.token0.symbol} to add</FieldLabel>
        <Input
          id="add-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={amount}
          onChange={(event) => setAmount(event.target.value.trim())}
        />
        <FieldDescription>
          Also adds {formatAmount(amount1, pool.token1.decimals)}{" "}
          {pool.token1.symbol}, in the pool's current ratio.
        </FieldDescription>
      </Field>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      <Button
        type="submit"
        disabled={amount0 === 0n || amount1 === 0n || Boolean(problem) || request.busy}
      >
        Add liquidity
      </Button>
    </form>
  );
}

/** Return LP tokens for a share of both reserves. */
export function RemoveLiquidityForm(props: FormProps) {
  const { config, reader, account, pool, state, request } = props;
  const [amount, setAmount] = useState("");
  const lpBalance = state.balances[2];
  const parsed = parseAmount(amount, pool.lpToken.decimals);
  const liquidity = parsed.ok ? parsed.value : 0n;
  const share = (reserve: bigint) =>
    state.totalLiquidity > 0n ? (liquidity * reserve) / state.totalLiquidity : 0n;
  const [out0, out1] = [share(state.reserves[0]), share(state.reserves[1])];
  const problem =
    amount && !parsed.ok
      ? "Enter a valid amount."
      : liquidity > lpBalance
        ? "Not enough LP tokens."
        : liquidity > 0n && (withSlippage(out0) === 0n || withSlippage(out1) === 0n)
          ? "The amount is too small to remove."
          : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (liquidity === 0n || problem) return;
    await request.submit("Remove liquidity", pool, [
      // The handler burns LP tokens from the caller's allowance.
      ...(await approvalIfNeeded(reader, pool.liquidityToken, pool.handler, liquidity)),
      removeLiquidityRequest(config.routerAddress, {
        tokenA: pool.token0.address,
        tokenB: pool.token1.address,
        liquidity,
        amountsMin: [withSlippage(out0), withSlippage(out1)],
        recipient: account,
      }),
    ]);
    setAmount("");
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <Field>
        <FieldLabel htmlFor="remove-amount">LP tokens to return</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="remove-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.0"
            value={amount}
            onChange={(event) => setAmount(event.target.value.trim())}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => setAmount(formatAmount(lpBalance, pool.lpToken.decimals))}
          >
            Max
          </Button>
        </div>
        <FieldDescription>
          You hold {formatAmount(lpBalance, pool.lpToken.decimals)} LP tokens.
          You receive about {formatAmount(out0, pool.token0.decimals)}{" "}
          {pool.token0.symbol} and {formatAmount(out1, pool.token1.decimals)}{" "}
          {pool.token1.symbol}.
        </FieldDescription>
      </Field>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      <Button
        type="submit"
        disabled={liquidity === 0n || Boolean(problem) || request.busy}
      >
        Remove liquidity
      </Button>
    </form>
  );
}
