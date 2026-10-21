import { toBase58, MockTransport } from "@thruputchain/client";
import { describe, expect, it, vi } from "vitest";

import { createReadClient } from "@/thruput/client";
import { configuration } from "@/test/fixtures";

describe("network-bound read client", () => {
  it.each([
    { networkHash: toBase58(new Uint8Array(32).fill(0x99)) },
    { networkHash: "broken" },
    null,
  ])(
    "rejects invalid identity %j without reading evidence and allows retry",
    async (networkInfo) => {
      const config = configuration();
      let response = networkInfo;
      const methods: string[] = [];
      const transport = new MockTransport();
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_url, init) => {
          const request = JSON.parse(init!.body as string);
          methods.push(request.method);
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result:
                request.method === "getNetworkInfo"
                  ? response
                  : await transport.request(request.method, request.params),
            }),
          );
        });
      try {
        await expect(createReadClient(config)).rejects.toThrow();
        expect(methods).not.toContain("getEvents");
        response = { networkHash: config.networkId };
        const client = await createReadClient(config);
        await expect(client.getNetworkInfo()).resolves.toHaveProperty(
          "networkHash",
        );
        response = networkInfo;
        await expect(
          client.getEvents({
            filters: [{ addresses: [config.factoryAddress] }],
            start: { order: "ascending", anchor: { kind: "atBeginning" } },
          }),
        ).rejects.toThrow();
        expect(!methods.includes("getEvents")).toBe(true);
      } finally {
        fetch.mockRestore();
      }
    },
  );
});
