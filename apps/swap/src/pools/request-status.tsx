import { AlertCircleIcon, CheckCircle2Icon, LoaderCircleIcon } from "lucide-react";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { useQueuedRequest } from "@/transactions/use-queued-request";

/** Shows where a queued request is: signing, pending, queued, or finished. */
export function RequestStatus({
  request,
}: {
  request: ReturnType<typeof useQueuedRequest>;
}) {
  const { tx, queued, finished, error } = request;
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {tx.pending ? (
        <Alert>
          <LoaderCircleIcon className="motion-safe:animate-spin" />
          <AlertTitle>{tx.pending.label}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>
              {tx.waitTimedOut
                ? "No receipt yet. The transaction can still commit, so do not sign a new one."
                : "Waiting for confirmation…"}
            </span>
            <BlockchainIdentifier
              kind="transaction"
              label="Transaction"
              value={tx.pending.hash}
            />
            <Button size="sm" variant="outline" onClick={() => void tx.checkAgain()}>
              Check again
            </Button>
          </AlertDescription>
        </Alert>
      ) : tx.busy ? (
        <Alert>
          <LoaderCircleIcon className="motion-safe:animate-spin" />
          <AlertTitle>Approve in your wallet</AlertTitle>
        </Alert>
      ) : null}
      {queued && !tx.pending && !tx.busy ? (
        <Alert>
          <LoaderCircleIcon className="motion-safe:animate-spin" />
          <AlertTitle>{queued.label}: queued</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>
              The pool accepted the request. A crank processes the queue; the
              app watches for the request's result.
            </span>
            <div className="flex flex-wrap gap-2">
              {request.canCrankAgain ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void request.processQueue()}
                >
                  Process the queue again
                </Button>
              ) : null}
              {request.unreadable ? (
                <Button size="sm" variant="outline" onClick={request.forget}>
                  Forget this request
                </Button>
              ) : null}
            </div>
            {request.unreadable ? (
              <span>
                If you forget it, a crank can still process the request. Its
                result then shows in your balances.
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {finished ? (
        <Alert variant={finished.outcome.status === "done" ? "default" : "destructive"}>
          {finished.outcome.status === "done" ? <CheckCircle2Icon /> : <AlertCircleIcon />}
          <AlertTitle>
            {finished.outcome.status === "done"
              ? `${finished.label}: done`
              : `${finished.label}: failed`}
          </AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>
              {finished.outcome.status === "done"
                ? "The pool processed the request."
                : "The pool could not process the request, for example because the price moved past your limit. Nothing moved."}
            </span>
            <Button size="sm" variant="outline" onClick={request.dismiss}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
