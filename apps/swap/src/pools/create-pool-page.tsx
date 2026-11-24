import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertCircleIcon } from "lucide-react";
import { addressFromBase58, toBase58 } from "@thruputchain/client";
import type { AppConfig } from "@/config";
import {
  addLiquidityRequest,
  approve,
  createPair,
  MINIMUM_LIQUIDITY,
  readAllowance,
  readBalance,
  readPool,
  readPoolAddresses,
  readPoolFunding,
  readToken,
  sortTokens,
  type PoolAddresses,
  type Token,
} from "@/contracts/swap";
import { fetchPoolTokenArtifact } from "@/contracts/pool-token-artifact";
import { formatAmount, parseAmount } from "@/domain/amount";
import { integerSquareRoot } from "@/domain/quote";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { typedAddress } from "@/lib/address";
import { userErrorMessage } from "@/lib/errors";
import { useSharedQueuedRequest } from "@/transactions/queued-request-provider";
import { RequestStatus } from "./request-status";
import { TokenField } from "./token-field";
import { useReader } from "./use-pool";

interface Review {
  token0: Token;
  token1: Token;
  amounts: [bigint, bigint];
  pool: PoolAddresses;
  /** Native tokens the factory takes for each of the pool's three contracts. */
  funding: bigint;
}

/**
 * Create a pool and add its first liquidity, in one transaction:
 * approve the factory's native-token funding, create the pair, approve both
 * tokens for the new pool, and queue the first deposit. The LP token's code is
 * deployed in the same transaction. A crank then processes the deposit.
 */
export function CreatePoolPage({ config }: { config: AppConfig }) {
  const [params] = useSearchParams();
  const { reader, account } = useReader(config);
  const request = useSharedQueuedRequest();
  const [tokenA, setTokenA] = useState(params.get("tokenA") ?? "");
  const [tokenB, setTokenB] = useState(params.get("tokenB") ?? "");
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  function edit(set: (value: string) => void) {
    return (value: string) => {
      set(value);
      setReview(null);
    };
  }

  async function reviewPool(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setReviewing(true);
    try {
      const a = typedAddress(tokenA);
      const b = typedAddress(tokenB);
      if (!a || !b) throw new Error("Enter two token addresses.");
      if (a === b) throw new Error("Choose two different tokens.");
      const [address0, address1] = sortTokens(addressFromBase58(a), addressFromBase58(b));
      if (await readPool(reader, address0, address1))
        throw new Error("A pool for these tokens already exists.");
      const [token0, token1, pool, funding] = await Promise.all([
        readToken(reader, address0),
        readToken(reader, address1),
        readPoolAddresses(reader, address0, address1),
        readPoolFunding(reader),
      ]);
      // The form's A/B order may differ from the pool's token0/token1 order.
      const aIsToken0 = toBase58(address0) === a;
      const parsedA = parseAmount(amountA, (aIsToken0 ? token0 : token1).decimals);
      const parsedB = parseAmount(amountB, (aIsToken0 ? token1 : token0).decimals);
      if (!parsedA.ok || !parsedB.ok || parsedA.value <= 0n || parsedB.value <= 0n)
        throw new Error("Enter two positive amounts.");
      const amounts: [bigint, bigint] = aIsToken0
        ? [parsedA.value, parsedB.value]
        : [parsedB.value, parsedA.value];
      if (integerSquareRoot(amounts[0] * amounts[1]) <= MINIMUM_LIQUIDITY)
        throw new Error(
          `Add more of each token: the pool locks ${MINIMUM_LIQUIDITY} LP base units forever.`,
        );
      const [balance0, balance1, nativeBalance] = await Promise.all([
        readBalance(reader, address0),
        readBalance(reader, address1),
        readBalance(reader, config.nativeTokenAddress),
      ]);
      if (balance0 < amounts[0] || balance1 < amounts[1])
        throw new Error("This wallet does not hold enough of both tokens.");
      // Creating the pool also funds its three contracts in native tokens. If
      // one side is the native token, the deposit comes out of the same balance.
      const native = toBase58(config.nativeTokenAddress);
      const nativeNeeded =
        funding * 3n +
        (toBase58(address0) === native ? amounts[0] : 0n) +
        (toBase58(address1) === native ? amounts[1] : 0n);
      if (nativeBalance < nativeNeeded)
        throw new Error(
          `This wallet needs ${nativeNeeded - nativeBalance} more native-token units: the factory funds the pool's three contracts too.`,
        );
      setReview({ token0, token1, amounts, pool, funding });
    } catch (reason) {
      setError(userErrorMessage(reason, "The pool could not be reviewed."));
    } finally {
      setReviewing(false);
    }
  }

  async function create() {
    if (!review) return;
    setError(null);
    const { token0, token1, amounts, pool } = review;
    await request.submit(`Create ${token0.symbol} / ${token1.symbol}`, pool, async () => {
      const totalFunding = review.funding * 3n;
      const [nativeAllowance, allowance0, allowance1, lpCode] = await Promise.all([
        readAllowance(reader, config.nativeTokenAddress, config.factoryAddress),
        readAllowance(reader, token0.address, pool.handler),
        readAllowance(reader, token1.address, pool.handler),
        fetchPoolTokenArtifact(config.poolTokenHash),
      ]);
      const missing = (needed: bigint, have: bigint) => (have < needed ? needed - have : 0n);
      const approvals = [
        [config.nativeTokenAddress, config.factoryAddress, missing(totalFunding, nativeAllowance)],
        [token0.address, pool.handler, missing(amounts[0], allowance0)],
        [token1.address, pool.handler, missing(amounts[1], allowance1)],
      ] as const;
      const [fundingApproval, approval0, approval1] = approvals.map(([token, spender, amount]) =>
        amount > 0n ? [approve(token, spender, amount)] : [],
      );
      return {
        calls: [
          ...fundingApproval!,
          createPair(config.factoryAddress, token0.address, token1.address, review.funding),
          ...approval0!,
          ...approval1!,
          addLiquidityRequest(config.routerAddress, {
            tokenA: token0.address,
            tokenB: token1.address,
            amountsDesired: amounts,
            // The first deposit sets the price, so it takes exactly these amounts.
            amountsMin: amounts,
            recipient: account,
          }),
        ],
        contractsToDeploy: [lpCode],
      };
    });
  }

  const done = request.finished?.outcome.status === "done" && review;
  return (
    <main className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-10 sm:px-6 md:grid-cols-[3fr_2fr]">
      <Card>
        <CardHeader>
          <CardTitle>Create a pool</CardTitle>
          <CardDescription>
            Choose two tokens and the first deposit. The first deposit sets the
            pool's price.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(event) => void reviewPool(event)}>
            <FieldGroup>
              <TokenField id="token-a" label="Token A" value={tokenA} onChange={edit(setTokenA)} disabled={request.busy} />
              <Field>
                <FieldLabel htmlFor="amount-a">Token A amount</FieldLabel>
                <Input id="amount-a" inputMode="decimal" placeholder="0.0" value={amountA} disabled={request.busy} onChange={(event) => edit(setAmountA)(event.target.value.trim())} />
              </Field>
              <TokenField id="token-b" label="Token B" value={tokenB} onChange={edit(setTokenB)} disabled={request.busy} />
              <Field>
                <FieldLabel htmlFor="amount-b">Token B amount</FieldLabel>
                <Input id="amount-b" inputMode="decimal" placeholder="0.0" value={amountB} disabled={request.busy} onChange={(event) => edit(setAmountB)(event.target.value.trim())} />
              </Field>
              <Button type="submit" disabled={reviewing || request.busy}>
                {reviewing ? "Reviewing…" : "Review pool"}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Check the pool</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <RequestStatus request={request} />
        {done ? (
          <Button asChild>
            <Link to={`/pools/${toBase58(review.token0.address)}/${toBase58(review.token1.address)}`}>
              Open the pool
            </Link>
          </Button>
        ) : review ? (
          <Card>
            <CardHeader>
              <CardTitle>
                {review.token0.symbol} / {review.token1.symbol}
              </CardTitle>
              <CardDescription>One transaction, then a crank.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p>
                Deposit {formatAmount(review.amounts[0], review.token0.decimals)}{" "}
                {review.token0.symbol} and{" "}
                {formatAmount(review.amounts[1], review.token1.decimals)}{" "}
                {review.token1.symbol}.
              </p>
              <p className="text-muted-foreground">
                The factory also takes {review.funding.toString()} native-token
                units for each of the pool's three contracts.
              </p>
              <Button disabled={request.busy} onClick={() => void create()}>
                Create pool
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </main>
  );
}
