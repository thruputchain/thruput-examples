import { BrowserRouter, useInRouterContext } from "react-router-dom";
import { AppProviders, ConfiguredApp } from "@/routes";
import type { AppConfig } from "@/config";
import type { SnapshotReader } from "@/swap/snapshot";
import type { RequestObserver } from "@/transactions/request-observer";
import type { WriteBoundary } from "@/transactions/write-boundary";

export function App(props: { config: AppConfig; readSnapshot?: SnapshotReader; requestObserver?: RequestObserver; writeBoundary?: WriteBoundary }) {
  const hasRouter = useInRouterContext();
  const content = <ConfiguredApp {...props} />;
  return <AppProviders explorerUrl={props.config.explorerUrl}>{hasRouter ? content : <BrowserRouter>{content}</BrowserRouter>}</AppProviders>;
}
