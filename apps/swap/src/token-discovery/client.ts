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
      `${import.meta.env.BASE_URL}api/token-discovery${q ? `?${new URLSearchParams({ q })}` : ""}`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: combined,
      },
    );
    return validateDiscoveryResponse(
      await readDiscoveryJson(response, combined),
      config.scope,
    );
  } catch {
    combined.throwIfAborted();
    throw new Error(
      "Token discovery is unavailable. Try again or use an address.",
    );
  } finally {
    clearTimeout(timeout);
  }
}
