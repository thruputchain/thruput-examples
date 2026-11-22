import { useState, type FormEvent } from "react";
import { ArrowDownUpIcon } from "lucide-react";
import type { ContractAddress } from "@thruputchain/protocol";
import type { AppConfig } from "@/config";
import {
  approve,
  readAllowance,
  swapRequest,
  type Pool,
  type PoolState,
  type Reader,
} from "@/contracts/swap";
import { formatAmount, parseAmount } from "@/domain/amount";
import { minimumAmountOut, quoteExactInput } from "@/domain/quote";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { useQueuedRequest } from "@/transactions/use-queued-request";
import { SLIPPAGE_BPS } from "./liquidity-forms";

/**
 * Swap an exact input amount. One batch approves exactly the missing allowance
 * for the pool's handler and queues the swap with the router. The handler
 * spends the allowance later, when a crank processes the request.
 */
export function SwapForm({
  config,
  reader,
  account,
  pool,
  state,
  request,
}: {
  config: AppConfig;
  reader: Reader;
  account: ContractAddress;
  pool: Pool;
  state: PoolState;
  request: ReturnType<typeof useQueuedRequest>;
}) {
  const [inputIndex, setInputIndex] = useState<0 | 1>(0);
  const [amount, setAmount] = useState("");
  const [tokenIn, tokenOut] =
    inputIndex === 0 ? [pool.token0, pool.token1] : [pool.token1, pool.token0];
  const reserveIn = state.reserves[inputIndex];
  const reserveOut = state.reserves[inputIndex === 0 ? 1 : 0];
  const parsed = parseAmount(amount, tokenIn.decimals);
  const amountIn = parsed.ok ? parsed.value : 0n;
  const quote = amountIn > 0n ? quoteExactInput(amountIn, reserveIn, reserveOut) : null;
  const amountOutMin = quote ? minimumAmountOut(quote.amountOut, SLIPPAGE_BPS) : 0n;
  const problem =
    amount && !parsed.ok
      ? "Enter a valid amount."
      : amountIn > state.balances[inputIndex]
        ? `Not enough ${tokenIn.symbol}.`
        : quote && amountOutMin === 0n
          ? "The amount is too small to swap."
          : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!quote || problem) return;
    const allowance = await readAllowance(reader, tokenIn.address, pool.handler);
    await request.submit(`Swap ${tokenIn.symbol} for ${tokenOut.symbol}`, pool, [
      ...(allowance < amountIn
        ? [approve(tokenIn.address, pool.handler, amountIn - allowance)]
        : []),
      swapRequest(config.routerAddress, {
        amountIn,
        amountOutMin,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        recipient: account,
      }),
    ]);
    setAmount("");
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <Field>
        <FieldLabel htmlFor="swap-amount">You pay ({tokenIn.symbol})</FieldLabel>
        <Input
          id="swap-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={amount}
          onChange={(event) => setAmount(event.target.value.trim())}
        />
        <FieldDescription>
          Balance: {formatAmount(state.balances[inputIndex], tokenIn.decimals)}{" "}
          {tokenIn.symbol}
        </FieldDescription>
      </Field>
      <Button
        type="button"
        variant="outline"
        className="self-center"
        aria-label="Switch tokens"
        onClick={() => {
          setInputIndex(inputIndex === 0 ? 1 : 0);
          setAmount("");
        }}
      >
        <ArrowDownUpIcon />
      </Button>
      <div className="rounded-lg bg-muted p-3 text-sm">
        <p>
          You receive about{" "}
          <strong>
            {quote ? formatAmount(quote.amountOut, tokenOut.decimals) : "0"}{" "}
            {tokenOut.symbol}
          </strong>
        </p>
        <p className="text-muted-foreground">
          At least {formatAmount(amountOutMin, tokenOut.decimals)}{" "}
          {tokenOut.symbol} ({Number(SLIPPAGE_BPS) / 100}% price tolerance). If
          the price moves further before the queue is processed, the swap
          fails and nothing moves.
        </p>
      </div>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      <Button type="submit" disabled={!quote || Boolean(problem) || request.busy}>
        Swap
      </Button>
    </form>
  );
}
