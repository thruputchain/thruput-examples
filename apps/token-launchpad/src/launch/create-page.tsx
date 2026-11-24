import { formatUnits, toBase58 } from "@thruputchain/client";
import { AlertCircleIcon, ArrowRightIcon, CheckCircle2Icon } from "lucide-react";
import type { AppConfig } from "@/config";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { Detail, IdentifierDetail } from "@/components/detail";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LaunchSuccessActions } from "./launch-success-actions";
import { createAmmPoolLink } from "./swap-link";
import { useLaunch } from "./use-launch";

const fields = [
  ["symbol", "Symbol", "e.g. CRED", "Required metadata."],
  ["name", "Token name", "e.g. Community Credits", "Required metadata."],
  ["decimals", "Decimals", "7", "Choose 0 to 18."],
  ["supply", "Initial supply", "1000000", "Assigned to the active wallet."],
] as const;

export function CreatePage({
  config,
  connected = true,
}: {
  config: AppConfig;
  connected?: boolean;
}) {
  const launch = useLaunch(config);
  const { tx, review, created } = launch;
  const locked = launch.reviewing || tx.blocked || created !== null;
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-8 max-w-2xl">
        <h1 className="app-page-title">Token Launchpad</h1>
        <p className="mt-2 text-base text-muted-foreground">
          Create a token on Thruput. Review the details, then launch.
        </p>
      </div>
      {!connected ? (
        <Alert className="mb-6">
          <AlertCircleIcon />
          <AlertTitle>Reconnect to continue</AlertTitle>
          <AlertDescription>
            Your token details are kept. Reconnect the same wallet to continue.
          </AlertDescription>
        </Alert>
      ) : null}
      {launch.error ? (
        <Alert variant="destructive" className="mb-6">
          <AlertCircleIcon />
          <AlertTitle>Launch unavailable</AlertTitle>
          <AlertDescription>{launch.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[23fr_17fr]">
        <Card>
          <CardHeader>
            <CardTitle>Token details</CardTitle>
            <CardDescription>Metadata is permanent after launch.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(event) => void launch.reviewLaunch(event)}>
              <FieldGroup>
                {fields.map(([key, label, placeholder, description]) => {
                  const error = launch.submitted
                    ? launch.parsed.errors[key]
                    : undefined;
                  return (
                    <Field key={key} data-invalid={Boolean(error)}>
                      <FieldLabel htmlFor={key}>{label}</FieldLabel>
                      <Input
                        id={key}
                        name={key}
                        value={launch.draft[key]}
                        placeholder={placeholder}
                        type={key === "decimals" ? "number" : "text"}
                        autoComplete="off"
                        inputMode={
                          key === "decimals" || key === "supply"
                            ? "decimal"
                            : "text"
                        }
                        aria-invalid={Boolean(error)}
                        disabled={locked}
                        onChange={(event) =>
                          launch.edit(key, event.target.value)
                        }
                      />
                      <FieldDescription>{description}</FieldDescription>
                      {error ? <FieldError>{error}</FieldError> : null}
                    </Field>
                  );
                })}
                {review === null && !tx.pending && !created ? (
                  <Button
                    className="min-h-12"
                    type="submit"
                    disabled={locked || !connected}
                  >
                    {launch.reviewing ? "Reviewing factory..." : "Review launch"}
                    <ArrowRightIcon data-icon="inline-end" />
                  </Button>
                ) : null}
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        <Card className="h-fit lg:sticky lg:top-6">
          {created ? (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2Icon aria-hidden="true" />
                  {created.symbol} launched
                </CardTitle>
                <CardDescription>{created.name}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <IdentifierDetail
                  label="Token address"
                  kind="address"
                  value={created.address}
                />
                <LaunchSuccessActions
                  onReset={launch.startOver}
                  disabled={false}
                  ammPoolLink={createAmmPoolLink(
                    config.swapAppUrl,
                    created.address,
                  )}
                />
              </CardContent>
            </>
          ) : tx.pending ? (
            <>
              <CardHeader>
                <CardTitle>Launching {tx.pending.context.symbol}</CardTitle>
                <CardDescription>
                  {tx.waitTimedOut
                    ? "No receipt yet. The launch can still commit, so do not sign a new one."
                    : "Waiting for confirmation…"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <IdentifierDetail
                  label="Transaction"
                  kind="transaction"
                  value={tx.pending.hash}
                />
                <Button variant="outline" onClick={() => void tx.checkAgain()}>
                  Check again
                </Button>
              </CardContent>
            </>
          ) : review ? (
            <>
              <CardHeader>
                <CardTitle>{review.token.symbol}</CardTitle>
                <CardDescription>
                  {review.token.name} · {review.token.decimals} decimals
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Detail
                  label="Initial supply"
                  value={formatUnits(
                    review.token.initialSupply,
                    review.token.decimals,
                  )}
                />
                <IdentifierDetail
                  label="Predicted address"
                  kind="address"
                  value={toBase58(review.predictedAddress)}
                />
                <Detail
                  label="Funding transfer"
                  value={`${review.fundingAmount} native-token units`}
                />
                {review.fundingShortfall > 0n ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertTitle>Not enough native tokens</AlertTitle>
                    <AlertDescription>
                      This wallet needs {review.fundingShortfall.toString()} more
                      native-token units to fund the token.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {launch.failed ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertTitle>The launch did not succeed</AlertTitle>
                    <AlertDescription>
                      The transaction committed, but execution failed. Funding
                      and creation were rolled back together.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  One transaction funds the predicted address and creates the
                  token. If either step fails, neither happens.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="min-h-12"
                    disabled={
                      tx.busy || !connected || review.fundingShortfall > 0n
                    }
                    onClick={() => void launch.launch()}
                  >
                    {tx.busy ? "Waiting for wallet..." : "Launch token"}
                  </Button>
                  <Button
                    className="min-h-12"
                    variant="outline"
                    disabled={tx.busy}
                    onClick={launch.startOver}
                  >
                    Edit details
                  </Button>
                </div>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <CardTitle>Review</CardTitle>
                <CardDescription>
                  Fill in the token details, then review the launch. The app
                  predicts the token's address before you sign.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Detail
                  label="Administrator and holder"
                  value={
                    <BlockchainIdentifier
                      kind="address"
                      value={toBase58(config.accountAddress)}
                    />
                  }
                />
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
