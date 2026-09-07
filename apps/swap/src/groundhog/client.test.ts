import { afterEach, describe, expect, it, vi } from "vitest";

import { contractAddress } from "@groundhogchain/protocol";
import { createNetworkReadClient, createReadClient, NetworkMismatchError, resolveReadRpcUrl, verifyReadNetwork } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("resolveReadRpcUrl", () => {
  it("uses the same-origin local proxy for separate loopback ports", () => {
    expect(
      resolveReadRpcUrl(
        { rpcUrl: new URL("http://127.0.0.1:9545") },
        "http://127.0.0.1:5173",
      ),
    ).toBe("http://127.0.0.1:5173/groundhog-rpc");
  });

  it("does not rewrite same-origin or non-loopback endpoints", () => {
    expect(
      resolveReadRpcUrl(
        { rpcUrl: new URL("http://127.0.0.1:9545") },
        "http://127.0.0.1:9545",
      ),
    ).toBe("http://127.0.0.1:9545/");
    expect(
      resolveReadRpcUrl(
        { rpcUrl: new URL("https://rpc.example.com") },
        "https://swap.example.com",
      ),
    ).toBe("https://rpc.example.com/");
  });

  it("always uses the same-origin proxy in registry-enabled browsers", () => {
    expect(
      resolveReadRpcUrl(
        {
          registryEnabled: true,
          rpcUrl: new URL("https://same-origin.invalid/"),
        },
        "https://swap.example.com",
      ),
    ).toBe("https://swap.example.com/groundhog-rpc");
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

describe("network-bound creation reads", () => {
  const address = contractAddress(new Uint8Array(32).fill(1));
  const config = {
    rpcUrl: new URL("http://127.0.0.1:9545"), networkIdHex: "00".repeat(32),
    accountAddress: address, factoryAddress: address, routerAddress: address, nativeHogAddress: address,
  };

  it("binds the SDK cluster and explicitly rereads network identity through the abort-aware transport", async () => {
    const controller = new AbortController();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.method).toBe("groundhog_networkInfo");
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { networkHash: `0x${config.networkIdHex}` } });
    });
    const client = await createNetworkReadClient(config, controller.signal);
    expect(client.cluster.networkHash).toEqual(new Uint8Array(32));
    await verifyReadNetwork(client, config);
    expect(fetcher).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it("sanitizes SDK network mismatch and rejects a changed network on the explicit check", async () => {
    let observed = "01".repeat(32);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => Response.json({
      jsonrpc: "2.0", id: JSON.parse(String(init?.body)).id, result: { networkHash: `0x${observed}` },
    }));
    await expect(createNetworkReadClient(config)).rejects.toBeInstanceOf(NetworkMismatchError);
    observed = config.networkIdHex;
    const client = await createNetworkReadClient(config);
    observed = "02".repeat(32);
    await expect(verifyReadNetwork(client, config)).rejects.toBeInstanceOf(NetworkMismatchError);
  });
});
