import { useState } from "react";
import { useClient } from "@thruputchain/react";
import type { AppConfig } from "@/config";
import { createSnapshotReader, type SnapshotReader } from "./snapshot";
import { SwapPage } from "./swap-page";
import {
  createRequestObserver,
  type RequestObserver,
} from "@/transactions/request-observer";
import type { WriteBoundary } from "@/transactions/write-boundary";
import { useTransactions } from "@/transactions/use-transactions";

export function SwapRoute({
  config,
  readSnapshot,
  requestObserver,
  writeBoundary,
}: {
  config: AppConfig;
  readSnapshot?: SnapshotReader | undefined;
  requestObserver?: RequestObserver | undefined;
  writeBoundary?: WriteBoundary | undefined;
}) {
  const client = useClient();
  const [reader] = useState<SnapshotReader>(
    () => readSnapshot ?? createSnapshotReader(config, client),
  );
  const connectedWriter = useTransactions(config);
  const writer = writeBoundary ?? connectedWriter;
  const [observer] = useState<RequestObserver>(
    () => requestObserver ?? createRequestObserver(config, client),
  );
  return (
    <SwapPage
      config={config}
      readSnapshot={reader}
      requestObserver={observer}
      writeBoundary={writer}
    />
  );
}
