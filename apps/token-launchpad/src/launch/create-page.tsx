import { AlertCircleIcon, ArrowRightIcon } from "lucide-react";
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
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ReviewCard } from "./review-card";
import { LaunchSuccessActions } from "./launch-success-actions";
import { createAmmPoolLink } from "./swap-link";
import { useLaunch, type LaunchOptions } from "./use-launch";
import { useWallet } from "@groundhogchain/react";

export function CreatePage(props: LaunchOptions) {
  const launch = useLaunch(props);
  const connected = props.connected ?? true;
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
            <p>
              Your token details and launch progress are saved. Reconnect the
              same wallet to continue.
            </p>
            <ReconnectWallet />
          </AlertDescription>
        </Alert>
      ) : null}
      {launch.error || launch.storageError ? (
        <Alert variant="destructive" className="mb-6">
          <AlertCircleIcon />
          <AlertTitle>Launch unavailable</AlertTitle>
          <AlertDescription>
            {launch.error ?? launch.storageError}
          </AlertDescription>
        </Alert>
      ) : null}
      {launch.storageError && launch.invalidDiscardable ? (
        <Button
          className="mb-6"
          variant="outline"
          onClick={launch.reset}
          disabled={launch.loading}
        >
          Discard invalid saved workflow
        </Button>
      ) : null}
      {launch.submitted && !launch.parsed.value ? (
        <Alert variant="destructive" className="mb-6">
          <AlertCircleIcon />
          <AlertTitle>Check the token details</AlertTitle>
          <AlertDescription>
            Correct the highlighted fields before reviewing this launch.
          </AlertDescription>
        </Alert>
      ) : null}
      {launch.workflow?.creation.status === "committed" ? (
        <LaunchSuccessActions
          className="mb-6 sm:flex-row sm:flex-wrap"
          onReset={launch.reset}
          disabled={launch.loading || !connected}
          ammPoolLink={createAmmPoolLink(
            props.config.swapAppUrl,
            launch.workflow,
          )}
        />
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[23fr_17fr]">
        <Card>
          <CardHeader>
            <CardTitle>Token details</CardTitle>
            <CardDescription>
              Metadata is permanent after launch.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={launch.submit}>
              <FieldGroup>
                {(
                  [
                    ["symbol", "Symbol", "e.g. CRED"],
                    ["name", "Token name", "e.g. Community Credits"],
                    ["decimals", "Decimals", "7"],
                    ["supply", "Initial supply", "1000000"],
                  ] as const
                ).map(([key, label, placeholder]) => {
                  const hasError =
                    launch.submitted && !!launch.parsed.errors[key];
                  return (
                    <Field key={key} data-invalid={hasError}>
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
                        aria-describedby={
                          hasError
                            ? `${key}-description ${key}-error`
                            : `${key}-description`
                        }
                        aria-invalid={hasError}
                        disabled={launch.loading || launch.workflow !== null}
                        onChange={(event) =>
                          launch.edit(key, event.target.value)
                        }
                      />
                      <FieldDescription id={`${key}-description`}>
                        {key === "supply"
                          ? "Assigned to the active wallet."
                          : key === "decimals"
                            ? "Choose 0 to 18."
                            : "Required metadata."}
                      </FieldDescription>
                      {hasError ? (
                        <FieldError id={`${key}-error`}>
                          {launch.parsed.errors[key]}
                        </FieldError>
                      ) : null}
                    </Field>
                  );
                })}
                {launch.workflow === null ? (
                  <Button
                    className="min-h-12"
                    type="submit"
                    disabled={
                      launch.loading ||
                      launch.storageError !== null ||
                      !connected
                    }
                  >
                    {launch.loading ? "Reviewing factory..." : "Review launch"}
                    <ArrowRightIcon data-icon="inline-end" />
                  </Button>
                ) : null}
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        <ReviewCard
          config={props.config}
          draft={launch.draft}
          review={launch.review}
          workflow={launch.workflow}
          loading={launch.loading}
          manualProcessing={launch.manualProcessing}
          onAdvance={launch.advance}
          onReset={launch.reset}
          onStartOver={launch.startOver}
          connected={connected}
        />
      </div>
      <Field
        orientation="horizontal"
        data-disabled={launch.loading}
        className="mt-6 px-1"
      >
        <FieldContent>
          <FieldTitle>Manual transaction processing</FieldTitle>
          <FieldDescription>
            Review and submit the funding and creation transactions separately.
          </FieldDescription>
        </FieldContent>
        <Switch
          aria-label="Manual transaction processing"
          checked={launch.manualProcessing}
          disabled={launch.loading}
          onCheckedChange={launch.setManualProcessing}
        />
      </Field>
    </main>
  );
}

function ReconnectWallet() {
  const wallet = useWallet();
  const busy =
    wallet.status === "connecting" || wallet.status === "disconnecting";
  return (
    <Button
      onClick={() => void wallet.connect()}
      disabled={!wallet.provider || busy}
    >
      {busy ? "Connecting..." : "Reconnect wallet"}
    </Button>
  );
}
