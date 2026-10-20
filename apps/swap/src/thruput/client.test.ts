import { afterEach, describe, expect, it, vi } from "vitest";

import { toBase58 } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { createReadClient, NetworkMismatchError, verifyReadNetwork } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("client initialization", () => {
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
      { rpcUrl: new URL("http://127.0.0.1:9545"), networkId: toBase58(new Uint8Array(32).fill(0x00)) },
      controller.signal,
    );
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    controller.abort(new DOMException("superseded", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transportSignal?.aborted).toBe(true);
  });
});

describe("network-bound creation reads", () => {
  const address = contractAddress(new Uint8Array(32).fill(1));
  const config = {
    rpcUrl: new URL("http://127.0.0.1:9545"), networkId: toBase58(new Uint8Array(32).fill(0x00)),
    accountAddress: address, factoryAddress: address, routerAddress: address, nativeHogAddress: address,
  };

  it("binds the SDK cluster and explicitly rereads network identity through the abort-aware transport", async () => {
    const controller = new AbortController();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.method).toBe("groundhog_networkInfo");
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { networkHash: toBase58(new Uint8Array(32)) } });
    });
    const client = await createReadClient(config, controller.signal);
    expect(client.cluster.networkHash).toEqual(new Uint8Array(32));
    await verifyReadNetwork(client, config);
    expect(fetcher).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it("sanitizes SDK network mismatch and rejects a changed network on the explicit check", async () => {
    let observed = toBase58(new Uint8Array(32).fill(1));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => Response.json({
      jsonrpc: "2.0", id: JSON.parse(String(init?.body)).id, result: { networkHash: observed },
    }));
    await expect(createReadClient(config)).rejects.toBeInstanceOf(NetworkMismatchError);
    observed = toBase58(new Uint8Array(32));
    const client = await createReadClient(config);
    observed = toBase58(new Uint8Array(32).fill(2));
    await expect(verifyReadNetwork(client, config)).rejects.toBeInstanceOf(NetworkMismatchError);
  });
});
