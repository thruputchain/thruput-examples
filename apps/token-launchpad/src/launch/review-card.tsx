import { toHex0x } from "@groundhogchain/client";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  RefreshCwIcon,
} from "lucide-react";
import type { AppConfig } from "@/config";
import type { FactoryReview } from "@/contracts/launchpad-client";
import {
  BlockchainIdentifier,
  ExplorerProvider,
} from "@/components/blockchain-identifier";
import { Detail, IdentifierDetail } from "@/components/detail";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatUnits, parseTokenDraft, type TokenDraft } from "./form";
import {
  actionLabel,
  canDiscardWorkflow,
  loadingActionLabel,
} from "./presentation";
import { createAmmPoolLink } from "./swap-link";
import { LaunchSuccessActions } from "./launch-success-actions";
import type { LaunchWorkflow } from "./workflow";
import { CONNECTION_LOST_MESSAGE } from "@/transactions/wallet-error";

export function ReviewCard({
  config,
  draft,
  review,
  workflow,
  loading,
  manualProcessing,
  onAdvance,
  onReset,
  onStartOver,
  writesSupported,
  connected = true,
}: {
  config: AppConfig;
  draft: TokenDraft;
  review: FactoryReview | null;
  workflow: LaunchWorkflow | null;
  loading: boolean;
  manualProcessing: boolean;
  onAdvance: () => void;
  onReset: () => void;
  onStartOver?: () => void;
  writesSupported: boolean;
  connected?: boolean;
}) {
  if (workflow)
    draft = {
      name: workflow.token.name,
      symbol: workflow.token.symbol,
      decimals: workflow.token.decimals.toString(),
      supply: formatUnits(
        BigInt(workflow.token.initialSupply),
        workflow.token.decimals,
      ),
    };
  const parsed = parseTokenDraft(draft).value;
  const predicted =
    review?.predictedAddressHex ?? workflow?.predictedAddressHex;
  const ammPoolLink = createAmmPoolLink(config.swapAppUrl, workflow);
  const label = workflow ? actionLabel(workflow, manualProcessing) : "";
  return (
    <ExplorerProvider explorerUrl={config.explorerUrl}>
      <Card className="h-fit lg:sticky lg:top-6">
        <CardHeader>
          <div className="mb-3 grid min-h-14 w-fit min-w-14 max-w-full place-items-center rounded-lg border bg-muted px-3 py-2 font-mono text-xl font-medium break-all">
            {draft.symbol.trim().toUpperCase() || "?"}
          </div>
          <CardTitle>{draft.symbol.trim().toUpperCase() || "SYMBOL"}</CardTitle>
          <CardDescription>
            {draft.name.trim() || "Your token"} · {draft.decimals || "0"}{" "}
            decimals
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Detail
            label="Initial supply"
            value={
              parsed ? formatUnits(parsed.initialSupply, parsed.decimals) : "-"
            }
          />
          <Detail
            label="Administrator"
            value={
              <BlockchainIdentifier
                kind="address"
                value={toHex0x(config.accountAddress)}
              />
            }
          />
          <Detail
            label="Initial holder"
            value={
              <BlockchainIdentifier
                kind="address"
                value={toHex0x(config.accountAddress)}
              />
            }
          />
          {predicted ? (
            <IdentifierDetail
              label="Predicted address"
              kind="address"
              value={predicted}
            />
          ) : (
            <Detail label="Predicted address" value="Available after review" />
          )}
          <Detail
            label="Factory fee"
            value={review || workflow ? "0 HOG" : "-"}
          />
          <Detail
            label="Required reserve"
            value={
              review
                ? `${review.config.required_token_funding} HOG units`
                : workflow
                  ? `${workflow.requiredTokenFunding} HOG units`
                  : "-"
            }
          />
          <Detail
            label="Funding transfer"
            value={
              review
                ? `${review.fundingAmount} HOG units`
                : workflow
                  ? `${workflow.plannedFundingAmount} HOG units`
                  : "-"
            }
          />
          {review?.fundingShortfall ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>Insufficient HOG</AlertTitle>
              <AlertDescription>
                This wallet needs at least {review.fundingShortfall.toString()}{" "}
                more HOG for token funding. Execution costs may require
                additional HOG.
              </AlertDescription>
            </Alert>
          ) : null}
          {workflow ? (
            <>
              <IdentifierDetail
                label="Application nonce"
                value={workflow.nonceHex}
              />
              <IdentifierDetail
                label="Implementation hash"
                value={workflow.reviewedTokenCodeHashHex}
              />
              <IdentifierDetail
                label="Native token"
                kind="address"
                value={workflow.reviewedNativeTokenHex}
              />
              {workflow.funding.hash ? (
                <IdentifierDetail
                  label="Funding transaction"
                  kind="transaction"
                  value={workflow.funding.hash}
                />
              ) : null}
              {workflow.creation.hash ? (
                <IdentifierDetail
                  label="Creation transaction"
                  kind="transaction"
                  value={workflow.creation.hash}
                />
              ) : null}
              {workflow.creationBlock ? (
                <Detail label="Creation block" value={workflow.creationBlock} />
              ) : null}
              {workflow.verification.totalSupply ? (
                <Detail
                  label="Verified total supply"
                  value={formatUnits(
                    BigInt(workflow.verification.totalSupply),
                    workflow.token.decimals,
                  )}
                />
              ) : null}
              {workflow.verification.holderBalance ? (
                <Detail
                  label="Verified holder balance"
                  value={formatUnits(
                    BigInt(workflow.verification.holderBalance),
                    workflow.token.decimals,
                  )}
                />
              ) : null}
              {workflow.createdAddressHex ? (
                <IdentifierDetail
                  label="Token contract"
                  kind="address"
                  value={workflow.createdAddressHex}
                />
              ) : null}
              <div className="space-y-3" aria-live="polite">
                <ProgressStep
                  label="Fund token address"
                  step={workflow.funding}
                />
                <ProgressStep
                  label="Create and initialize token"
                  step={workflow.creation}
                />
                <ProgressStatus
                  label="Verify committed token"
                  status={
                    workflow.creation.status !== "committed"
                      ? "pending"
                      : workflow.verification.status === "complete"
                        ? "complete"
                        : "incomplete"
                  }
                />
                {workflow.error && !loading && connected ? (
                  <Alert
                    variant={
                      workflow.error === CONNECTION_LOST_MESSAGE
                        ? "default"
                        : "destructive"
                    }
                  >
                    <AlertCircleIcon />
                    <AlertTitle>
                      {workflow.error === CONNECTION_LOST_MESSAGE
                        ? "Wallet reconnected"
                        : "Launch needs attention"}
                    </AlertTitle>
                    <AlertDescription>
                      {workflow.error === CONNECTION_LOST_MESSAGE
                        ? "Your launch is ready to continue. Retry the incomplete step below."
                        : workflow.error}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {workflow.creation.status === "committed" ? (
                  <>
                    <Alert>
                      <CheckCircle2Icon />
                      <AlertTitle>Token created</AlertTitle>
                      <AlertDescription>
                        {workflow.verification.status === "complete"
                          ? "Receipt, events, metadata, supply, and holder balance match this launch."
                          : "The receipt and creation events match this launch."}
                      </AlertDescription>
                    </Alert>
                    {workflow.verification.status === "incomplete" ? (
                      <>
                        <Alert>
                          <AlertCircleIcon />
                          <AlertTitle>Verification incomplete</AlertTitle>
                          <AlertDescription>
                            {workflow.verification.message}
                          </AlertDescription>
                        </Alert>
                        <Button
                          className="min-h-12 w-full"
                          onClick={onAdvance}
                          disabled={loading || !writesSupported || !connected}
                          variant="outline"
                        >
                          {loading
                            ? "Verifying token..."
                            : "Retry verification"}
                          <RefreshCwIcon />
                        </Button>
                      </>
                    ) : null}
                    <LaunchSuccessActions
                      onReset={onReset}
                      disabled={loading || !writesSupported || !connected}
                      ammPoolLink={ammPoolLink}
                    />
                  </>
                ) : (
                  <>
                    <Button
                      className="min-h-12 w-full"
                      onClick={onAdvance}
                      disabled={loading || !writesSupported || !connected}
                      variant={
                        label === "Create token" || label === "Launch token"
                          ? "default"
                          : "outline"
                      }
                    >
                      {!connected
                        ? "Reconnect to continue"
                        : loading
                          ? loadingActionLabel(workflow, manualProcessing)
                          : label}
                      <ArrowRightIcon />
                    </Button>
                    <p className="text-sm text-muted-foreground">
                      {loading
                        ? "Check your wallet for an approval request. If it times out, you can retry here."
                        : workflow.funding.status === "committed"
                          ? "Funding is complete. Continue at this token address; you do not need to fund it again."
                          : "Launching may need two wallet approvals: one to fund the token address and one to create the token."}
                    </p>
                    {canDiscardWorkflow(workflow) ? (
                      <div className="flex flex-col gap-3">
                        <Button
                          className="min-h-12 w-full"
                          variant="outline"
                          onClick={onReset}
                          disabled={loading || !writesSupported}
                        >
                          Edit token details
                        </Button>
                        {onStartOver ? (
                          <Button
                            variant="ghost"
                            onClick={onStartOver}
                            disabled={loading || !writesSupported}
                          >
                            Start over
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </>
          ) : review ? (
            <Alert>
              <CheckCircle2Icon />
              <AlertTitle>Factory verified</AlertTitle>
              <AlertDescription>
                The address and zero-fee factory configuration are ready.
                Continue to fund the predicted address.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </ExplorerProvider>
  );
}

function ProgressStep({
  label,
  step,
}: {
  label: string;
  step: LaunchWorkflow["funding"];
}) {
  const status =
    step.status === "idle"
      ? "pending"
      : step.status === "signing" || step.status === "pending"
        ? "active"
        : step.status === "committed"
          ? "complete"
          : step.status;
  return (
    <div className="space-y-1">
      <ProgressStatus label={label} status={status} />
      {step.hash ? (
        <p className="px-3 font-mono text-xs text-muted-foreground">
          <BlockchainIdentifier kind="transaction" value={step.hash} />
        </p>
      ) : null}
    </div>
  );
}

function ProgressStatus({ label, status }: { label: string; status: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <span>{label}</span>
      <Badge variant={status === "complete" ? "secondary" : "outline"}>
        {status}
      </Badge>
    </div>
  );
}
