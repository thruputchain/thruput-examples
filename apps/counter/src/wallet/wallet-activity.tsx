import { ExecResult } from "@groundhogchain/client";
import type { useWalletCounter } from "./use-wallet-counter";
import { BlockchainIdentifier } from "../components/blockchain-identifier";

export function WalletActivity({ activity, explorerUrl }: { activity: ReturnType<typeof useWalletCounter>; explorerUrl: string | null }) {
  const { pending, receipt, execution } = activity;
  if (!pending.record && !pending.error && !execution.error && !execution.isPending) return null;
  return <section aria-label="Wallet transaction" className="flex flex-col gap-3 border-t pt-6">
    <h2 className="text-lg">Wallet transaction</h2>
    {execution.isPending ? <p role="status">Waiting for wallet approval or confirmation…</p> : null}
    {execution.error ? <p role="alert">{execution.error.message}</p> : null}
    {pending.error ? <p role="alert">{pending.error}</p> : null}
    {pending.record ? <>
      <p>Original account <BlockchainIdentifier value={pending.record.account.address} kind="address" explorerUrl={explorerUrl} /></p>
      <p>Transaction <BlockchainIdentifier value={pending.record.hash} kind="tx" explorerUrl={explorerUrl} /></p>
      {receipt.data ? <>
        <p role="status">{receipt.data.execResult === ExecResult.ExecResultOK ? "Counter update committed." : "The transaction committed with failed execution."}</p>
        <div><button type="button" className="rounded-md border px-3 py-2 text-sm hover:bg-accent" onClick={activity.finish}>Finish</button></div>
      </> : <>
        <p>Keep this hash until its result is known. A timeout does not cancel the transaction.</p>
        {receipt.error ? <p role="alert">{receipt.error.message}</p> : null}
        <div><button type="button" className="rounded-md border px-3 py-2 text-sm hover:bg-accent" disabled={execution.isPending || receipt.isFetching} onClick={() => void receipt.refetch()}>Check transaction</button></div>
      </>}
    </> : null}
  </section>;
}
