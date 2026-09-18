import { BrowserRouter, useInRouterContext } from "react-router-dom";
import { SwapRoute } from "@/swap/swap-route";
import { AppLayout } from "@/app-layout";
import { ExplorerProvider } from "@/components/explorer-context";
import { ProcessingModeProvider } from "@/components/processing-mode";
import type { AppConfig } from "@/config";
import type { SnapshotReader } from "@/swap/snapshot";
import type { RequestObserver } from "@/transactions/request-observer";
import type { WriteBoundary } from "@/transactions/write-boundary";

export function App(props: {
  config: AppConfig;
  readSnapshot?: SnapshotReader;
  requestObserver?: RequestObserver;
  writeBoundary?: WriteBoundary;
}) {
  const hasRouter = useInRouterContext();
  const content = (
    <AppLayout>
      <SwapRoute {...props} />
    </AppLayout>
  );
  return (
    <ExplorerProvider value={props.config.explorerUrl}>
      <ProcessingModeProvider>
        {hasRouter ? content : <BrowserRouter>{content}</BrowserRouter>}
      </ProcessingModeProvider>
    </ExplorerProvider>
  );
}
