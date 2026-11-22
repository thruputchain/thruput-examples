// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { addressFromBase58, toBase58 } from "@thruputchain/client";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { AppConfig } from "@/config";
import { useTokenDirectory } from "./use-token-directory";

const account = toBase58(new Uint8Array(32).fill(7));
const config = {
  networkId: toBase58(new Uint8Array(32)),
  accountAddress: addressFromBase58(account),
} as AppConfig;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

it("reads the first page, and filters by creator for My Tokens", async () => {
  const read = vi.fn().mockResolvedValue({
    tokens: [],
    hasMore: false,
    indexedThrough: "5",
  });
  const all = renderHook(
    () => useTokenDirectory({ config, scope: "all", read }),
    { wrapper },
  );
  await waitFor(() => expect(all.result.current.page).not.toBeNull());
  expect(read).toHaveBeenLastCalledWith(
    { limit: 20, offset: 0 },
    expect.anything(),
  );

  const mine = renderHook(
    () => useTokenDirectory({ config, scope: "mine", read }),
    { wrapper },
  );
  await waitFor(() => expect(mine.result.current.page).not.toBeNull());
  expect(read).toHaveBeenLastCalledWith(
    { creator: account, limit: 20, offset: 0 },
    expect.anything(),
  );
});

it("reports an unavailable token list", async () => {
  const read = vi.fn().mockRejectedValue(new Error("offline"));
  const { result } = renderHook(
    () => useTokenDirectory({ config, scope: "all", read }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.error).not.toBeNull());
});
