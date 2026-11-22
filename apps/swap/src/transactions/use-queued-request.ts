import { useEffect, useState } from "react";
import { useClient } from "@thruputchain/react";
import {
  addressFromBase58,
  fixedBytes,
  fromHex0x,
  toBase58,
  toHex0x,
  type ContractCall,
} from "@thruputchain/client";
import type { Contract, ContractAddress } from "@thruputchain/protocol";
import { useQueryClient } from "@tanstack/react-query";
import {
  acceptedRequestId,
  crank,
  findRequestOutcome,
  type PoolAddresses,
  type RequestOutcome,
} from "@/contracts/swap";
import { userErrorMessage } from "@/lib/errors";
import { useWalletTransaction } from "./use-wallet-transaction";

/** A request the driver accepted, saved until its outcome is known. */
interface Queued {
  label: string;
  driver: string;
  handler: string;
  requestId: string;
  /** The block that queued the request: its outcome is at or after it. */
  fromBlock: string;
  /** True once this app sent a crank for it. */
  cranked: boolean;
}

/** What the wallet transaction needs to continue after a reload. */
interface Context {
  kind: "request" | "crank";
  label: string;
  driver: string;
  handler: string;
}

export interface Finished {
  label: string;
  outcome: RequestOutcome;
}

function load(key: string): Queued | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Queued | null;
    return saved && typeof saved.requestId === "string" ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Run one swap or liquidity request through the queue, and survive a reload.
 *
 * 1. `submit` sends the approvals and the router call in one batch. The
 *    receipt's `RequestAccepted` event gives the request ID.
 * 2. The app sends one crank (`process_requests`). This is a second wallet
 *    transaction, because the queue is processed in a later transaction.
 * 3. The app looks for the request's outcome event until it finds it. If the
 *    request is still queued after the crank, the user can crank again.
 *    Another user's crank can also process it.
 */
export function useQueuedRequest(networkId: string, account: ContractAddress) {
  const client = useClient();
  const queries = useQueryClient();
  const base = `swap:${networkId}:${toBase58(account)}`;
  const [queued, setQueued] = useState(() => load(`${base}:queued`));
  const [finished, setFinished] = useState<Finished | null>(null);
  const [error, setError] = useState<string | null>(null);

  function save(next: Queued | null) {
    if (next) localStorage.setItem(`${base}:queued`, JSON.stringify(next));
    else localStorage.removeItem(`${base}:queued`);
    setQueued(next);
  }

  const tx = useWalletTransaction<Context>(`${base}:transaction`, (done) => {
    if (!done.succeeded) {
      setError(
        done.context.kind === "request"
          ? `${done.label} failed. Nothing was queued.`
          : "The crank failed. The request is still queued.",
      );
      return;
    }
    if (done.context.kind === "request") {
      const driver = addressFromBase58(done.context.driver);
      save({
        label: done.context.label,
        driver: done.context.driver,
        handler: done.context.handler,
        requestId: toHex0x(acceptedRequestId(done.receipt, driver)),
        fromBlock: done.receipt.blockHeight.toString(),
        cranked: false,
      });
    }
  });

  async function check(request: Queued) {
    try {
      const outcome = await findRequestOutcome(
        client,
        {
          driver: addressFromBase58(request.driver),
          handler: addressFromBase58(request.handler),
        },
        fixedBytes(fromHex0x(request.requestId), 32),
        account,
        BigInt(request.fromBlock),
      );
      if (!outcome) return;
      save(null);
      setFinished({ label: request.label, outcome });
      void queries.invalidateQueries();
    } catch (reason) {
      setError(userErrorMessage(reason, "The request's outcome is unavailable."));
    }
  }

  async function processQueue(request: Queued) {
    const next = { ...request, cranked: true };
    save(next);
    await tx.send(
      "Process the queue",
      { calls: [crank(addressFromBase58(request.driver))] },
      {
        kind: "crank",
        label: request.label,
        driver: request.driver,
        handler: request.handler,
      },
    );
  }

  // Look for the outcome while the request is queued.
  useEffect(() => {
    if (!queued) return;
    void check(queued);
    const timer = setInterval(() => void check(queued), 3_000);
    return () => clearInterval(timer);
  }, [queued?.requestId]);

  // Send one crank automatically, once the wallet is free.
  useEffect(() => {
    if (queued && !queued.cranked && !tx.blocked) void processQueue(queued);
  }, [queued, tx.blocked]);

  return {
    tx,
    queued,
    finished,
    error: error ?? tx.message,
    busy: tx.blocked || queued !== null,
    async submit(
      label: string,
      pool: Pick<PoolAddresses, "driver" | "handler">,
      calls: readonly ContractCall[],
      contractsToDeploy?: Contract[],
    ) {
      setError(null);
      setFinished(null);
      await tx.send(
        label,
        { calls, ...(contractsToDeploy ? { contractsToDeploy } : {}) },
        {
          kind: "request",
          label,
          driver: toBase58(pool.driver),
          handler: toBase58(pool.handler),
        },
      );
    },
    processQueue: () => (queued ? processQueue(queued) : Promise.resolve()),
    dismiss() {
      setFinished(null);
      setError(null);
      tx.reset();
    },
  };
}
