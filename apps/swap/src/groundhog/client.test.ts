import { afterEach, describe, expect, it, vi } from "vitest";

import { createReadClient, resolveReadRpcUrl } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("resolveReadRpcUrl", () => {
  it("uses the same-origin local proxy for separate loopback ports", () => {
    expect(
      resolveReadRpcUrl(
        new URL("http://127.0.0.1:9545"),
        "http://127.0.0.1:5173",
      ),
    ).toBe("http://127.0.0.1:5173/groundhog-rpc");
  });

  it("does not rewrite same-origin or non-loopback endpoints", () => {
    expect(
      resolveReadRpcUrl(
        new URL("http://127.0.0.1:9545"),
        "http://127.0.0.1:9545",
      ),
    ).toBe("http://127.0.0.1:9545/");
    expect(
      resolveReadRpcUrl(
        new URL("https://rpc.example.com"),
        "https://swap.example.com",
      ),
    ).toBe("https://rpc.example.com/");
  });
});

describe("createReadClient", () => {
  it("aborts transport requests when its lifecycle signal is aborted", async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      transportSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        transportSignal?.addEventListener(
          "abort",
          () => reject(transportSignal?.reason),
          { once: true },
        );
      });
    });
    const pending = createReadClient(
      { rpcUrl: new URL("http://127.0.0.1:9545") },
      controller.signal,
    ).getChainTip();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    controller.abort(new DOMException("superseded", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transportSignal?.aborted).toBe(true);
  });
});
