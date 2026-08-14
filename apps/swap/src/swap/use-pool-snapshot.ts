import { useCallback, useEffect, useRef, useState } from "react";

import type { PoolSnapshot, SnapshotReader } from "@/swap/snapshot";

export const SNAPSHOT_REFRESH_INTERVAL_MS = 15_000;

export interface PoolSnapshotState {
  snapshot: PoolSnapshot | null;
  error: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  isUserRefreshing: boolean;
  refresh: () => void;
}

export function usePoolSnapshot(read: SnapshotReader): PoolSnapshotState {
  const request = useRef(0);
  const active = useRef(false);
  const hasSnapshot = useRef(false);
  const [state, setState] = useState<
    Omit<PoolSnapshotState, "refresh">
  >({
    snapshot: null,
    error: null,
    isLoading: true,
    isRefreshing: false,
    isUserRefreshing: false,
  });

  const runRefresh = useCallback((kind: "initial" | "manual" | "background") => {
    if (kind === "background" && active.current) return;
    active.current = true;
    const currentRequest = ++request.current;
    setState((current) => ({
      ...current,
      error: current.snapshot === null ? current.error : null,
      isLoading: current.snapshot === null,
      isRefreshing: current.snapshot !== null,
      isUserRefreshing: kind === "manual",
    }));

    void read().then(
      (snapshot) => {
        if (request.current !== currentRequest) return;
        active.current = false;
        hasSnapshot.current = true;
        setState({
          snapshot,
          error: null,
          isLoading: false,
          isRefreshing: false,
          isUserRefreshing: false,
        });
      },
      (error: unknown) => {
        if (request.current !== currentRequest) return;
        active.current = false;
        setState((current) => ({
          ...current,
          error: describeReadError(error),
          isLoading: false,
          isRefreshing: false,
          isUserRefreshing: false,
        }));
      },
    );
  }, [read]);

  const refresh = useCallback(() => runRefresh("manual"), [runRefresh]);

  useEffect(() => {
    runRefresh("initial");
    return () => {
      request.current += 1;
    };
  }, [runRefresh]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible" && hasSnapshot.current) {
        runRefresh("background");
      }
    };
    const interval = window.setInterval(
      refreshWhenVisible,
      SNAPSHOT_REFRESH_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [runRefresh]);

  return { ...state, refresh };
}

function describeReadError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return `The configured RPC could not load the pool: ${error.message}`;
  }
  return "The configured RPC could not load the pool.";
}
