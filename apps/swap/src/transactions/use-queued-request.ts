import { useEffect, useRef, useState } from "react";
import { useClient } from "@thruputchain/react";
import {
  addressFromBase58,
  fixedBytes,
  fromHex0x,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import type { ContractAddress } from "@thruputchain/protocol";
import { useQueryClient } from "@tanstack/react-query";
import {
  acceptedRequestId,
  crank,
  findRequestOutcome,
  type PoolAddresses,
  type RequestOutcome,
} from "@/contracts/swap";
import { userErrorMessage } from "@/lib/errors";
import {
  useWalletTransaction,
  type WalletRequest,
} from "./use-wallet-transaction";

/** A request the driver accepted, saved until its outcome is known. */
interface Queued {
  label: string;
  driver: string;
  handler: string;
  requestId: string;
  /** The block that queued the request: its outcome is at or after it. */
  fromBlock: string;
  /** True once a crank this app sent for it committed. */
  cranked: boolean;
}

/** What the wallet transaction needs to continue after a reload. */
interface Context {
  kind: "request" | "crank";
  label: string;
  driver: string;
  handler: string;
  /** For a crank: the request it was sent for. */
  requestId?: string;
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
  const queuedKey = `${base}:queued`;
  const [queued, setQueued] = useState(() => load(queuedKey));
  const [finished, setFinished] = useState<Finished | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True after an outcome check fails: the user can then forget the request.
  const [unreadable, setUnreadable] = useState(false);
  const checking = useRef(false);
  // The request this tab asked the wallet to crank. Not saved: if a reload
  // interrupts signing, nothing was sent, so the app asks once more.
  const [crankAsked, setCrankAsked] = useState<string | null>(null);

  function save(next: Queued | null) {
    if (next) localStorage.setItem(queuedKey, JSON.stringify(next));
    else localStorage.removeItem(queuedKey);
    setQueued(next);
    setUnreadable(false);
  }

  const tx = useWalletTransaction<Context>(`${base}:transaction`, (done) => {
    if (done.context.kind === "crank") {
      // Whatever its result, the crank was sent: do not send another on its own.
      const current = load(queuedKey);
      if (current && current.requestId === done.context.requestId)
        save({ ...current, cranked: true });
    }
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

  /**
   * Look for one request's outcome. One check runs at a time, and a check
   * clears only the request it looked for: a slow check for an earlier request
   * must not clear the next one.
   */
  async function check(request: Queued) {
    if (checking.current) return;
    checking.current = true;
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
      setUnreadable(false);
      if (!outcome || load(queuedKey)?.requestId !== request.requestId) return;
      save(null);
      setFinished({ label: request.label, outcome });
      void queries.invalidateQueries();
    } catch (reason) {
      // For example, the node no longer keeps history back to `fromBlock`.
      setUnreadable(true);
      setError(userErrorMessage(reason, "The request's outcome is unavailable."));
    } finally {
      checking.current = false;
    }
  }

  async function processQueue(request: Queued) {
    setCrankAsked(request.requestId);
    await tx.send(
      "Process the queue",
      () => ({ calls: [crank(addressFromBase58(request.driver))] }),
      {
        kind: "crank",
        label: request.label,
        driver: request.driver,
        handler: request.handler,
        requestId: request.requestId,
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

  // Ask for one crank automatically, once the wallet is free.
  useEffect(() => {
    if (
      queued &&
      !queued.cranked &&
      crankAsked !== queued.requestId &&
      !tx.blocked
    )
      void processQueue(queued);
  }, [queued, crankAsked, tx.blocked]);

  return {
    tx,
    queued,
    finished,
    error: error ?? tx.message,
    busy: tx.blocked || queued !== null,
    unreadable,
    /** The user can crank by hand once the app has asked for its own crank. */
    canCrankAgain:
      queued !== null &&
      (queued.cranked || crankAsked === queued.requestId),
    /** `build` returns the calls; see `useWalletTransaction`'s `send`. */
    async submit(
      label: string,
      pool: Pick<PoolAddresses, "driver" | "handler">,
      build: () => WalletRequest | Promise<WalletRequest>,
    ) {
      setError(null);
      setFinished(null);
      await tx.send(
        label,
        build,
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
    /**
     * Stop watching a request whose outcome cannot be read. The request itself
     * is unchanged: a crank can still process it, and its result shows in the
     * pool's balances.
     */
    forget() {
      save(null);
      setError(null);
    },
  };
}
