import { createContext, useContext, type ReactNode } from "react";
import type { AppConfig } from "@/config";
import { useReader } from "@/pools/use-pool";
import { useQueuedRequest } from "./use-queued-request";

type QueuedRequest = ReturnType<typeof useQueuedRequest>;

const QueuedRequestContext = createContext<QueuedRequest | null>(null);

/**
 * One queued-request tracker above the routes. A request the wallet is still
 * sending finishes into this tracker, so moving to another page cannot lose
 * it. Mount it with `key={account}`: each account has its own saved request.
 */
export function QueuedRequestProvider({
  config,
  children,
}: {
  config: AppConfig;
  children: ReactNode;
}) {
  const { account } = useReader(config);
  const request = useQueuedRequest(config.networkId, account);
  return (
    <QueuedRequestContext.Provider value={request}>
      {children}
    </QueuedRequestContext.Provider>
  );
}

/** The tracker from `QueuedRequestProvider`. */
export function useSharedQueuedRequest(): QueuedRequest {
  const request = useContext(QueuedRequestContext);
  if (!request) throw new Error("Wrap the routes in QueuedRequestProvider.");
  return request;
}
