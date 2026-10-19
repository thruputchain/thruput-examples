import { addressFromBase58, toHex0x } from "@thruputchain/client";
import type { DiscoveryConfig } from "./config.ts";
import {
  discoveryQuery,
  readDiscoveryJson,
  validateDiscoveryResponse,
  type DiscoveryResponse,
} from "./wire.ts";

export async function getDiscoveryTokens(
  config: DiscoveryConfig,
  query = "",
  signal?: AbortSignal,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<DiscoveryResponse> {
  if (!config.enabled || !config.scope)
    throw new Error("Token discovery is disabled");
  const q = discoveryQuery(query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    const response = await fetcher(
      `/api/token-discovery${q ? `?${new URLSearchParams({ q })}` : ""}`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: combined,
      },
    );
    const page = validateDiscoveryResponse(
      await readDiscoveryJson(response, combined),
      config.scope,
    );
    // Token form state is 0x hex; the registry wire is base58.
    return {
      ...page,
      tokens: page.tokens.map((token) => ({
        ...token,
        tokenAddress: toHex0x(addressFromBase58(token.tokenAddress)),
        creatorAddress: toHex0x(addressFromBase58(token.creatorAddress)),
      })),
    };
  } catch {
    combined.throwIfAborted();
    throw new Error(
      "Token discovery is unavailable. Try again or use an address.",
    );
  } finally {
    clearTimeout(timeout);
  }
}
