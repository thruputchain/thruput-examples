// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { getDiscoveryTokens } from "./client.ts";
import { loadDiscoveryConfig } from "./config.ts";
import { validateDiscoveryResponse } from "./wire.ts";

const address = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const config = loadDiscoveryConfig({
  VITE_TOKEN_DISCOVERY_ENABLED: "true",
  VITE_THRUPUT_NETWORK_ID: "ab".repeat(32),
  VITE_STANDARD_TOKEN_FACTORY_ADDRESS: address(1),
  VITE_STANDARD_TOKEN_HASH: address(2),
});
const token = {
  tokenAddress: address(3),
  creatorAddress: address(4),
  name: "Untrusted <b>text</b>",
  symbol: "T",
  decimals: 18,
};
const response = {
  scope: config.scope,
  tokens: [token],
  hasMore: false,
  historyLimited: false,
  syncState: "idle",
};

describe("browser token discovery client", () => {
  it("only fetches the same-origin search endpoint and returns server order unchanged", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(response));
    expect(
      await getDiscoveryTokens(config, " creator ", undefined, fetcher),
    ).toEqual(response);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/token-discovery?q=creator",
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
  });
  it("makes no request when disabled or the search is oversized", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      getDiscoveryTokens(loadDiscoveryConfig({}), "", undefined, fetcher),
    ).rejects.toThrow(/disabled/);
    await expect(
      getDiscoveryTokens(config, "é".repeat(51), undefined, fetcher),
    ).rejects.toThrow(/100/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { ...response, extra: "private" },
    { ...response, scope: { ...config.scope, extra: "private" } },
    { ...response, scope: { ...config.scope, networkId: "cd".repeat(32) } },
    { ...response, scope: { ...config.scope, factoryAddress: address(99) } },
    { ...response, scope: { ...config.scope, tokenCodeHash: address(99) } },
    { ...response, tokens: [{ ...token, blockHeight: "1" }] },
    { ...response, tokens: [{ ...token, tokenAddress: address(0) }] },
    { ...response, tokens: [{ ...token, tokenAddress: `${address(3)}\n` }] },
    { ...response, tokens: [{ ...token, decimals: 256 }] },
    { ...response, tokens: [{ ...token, name: "é".repeat(129) }] },
    { ...response, tokens: [{ ...token, symbol: "é".repeat(33) }] },
    { ...response, tokens: [token, token] },
    { ...response, hasMore: true },
    { ...response, historyLimited: "false" },
    { ...response, syncState: "integrityFault" },
  ])("strictly rejects malformed projections", (value) => {
    expect(() => validateDiscoveryResponse(value, config.scope!)).toThrow();
  });
  it("accepts scoped empty pages and nullable metadata", () => {
    expect(
      validateDiscoveryResponse({ ...response, tokens: [] }, config.scope!)
        .tokens,
    ).toEqual([]);
    expect(
      validateDiscoveryResponse(
        {
          ...response,
          tokens: [{ ...token, name: null, symbol: null, decimals: null }],
        },
        config.scope!,
      ).tokens[0]?.decimals,
    ).toBeNull();
  });
  it("does not reflect upstream error bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private host secret", { status: 502 }));
    await expect(
      getDiscoveryTokens(config, "", undefined, fetcher),
    ).rejects.toThrow(
      "Token discovery is unavailable. Try again or use an address.",
    );
  });
  it("cancels a body when the caller aborts", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const pending = getDiscoveryTokens(config, "", controller.signal, fetcher);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled();
  });
});
