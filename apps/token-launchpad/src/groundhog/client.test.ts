import { describe, expect, it, vi } from "vitest";

import { createReadClient, resolveReadRpcUrl } from "@/groundhog/client";
import { configuration } from "@/test/fixtures";

describe("network-bound read client", () => {
  it.each([
    { networkHash: `0x${"99".repeat(32)}` },
    { networkHash: "broken" },
    null,
  ])(
    "rejects invalid identity %j without reading evidence and allows retry",
    async (networkInfo) => {
      const config = configuration();
      let response = networkInfo;
      const methods: string[] = [];
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
                request.method === "groundhog_networkInfo" ? response : null,
            }),
          );
        });
      try {
        await expect(createReadClient(config)).rejects.toThrow();
        expect(methods).toEqual(["groundhog_networkInfo"]);
        response = { networkHash: `0x${config.networkIdHex}` };
        const client = await createReadClient(config);
        await expect(client.getNetworkInfo()).resolves.toHaveProperty(
          "networkHash",
        );
        response = networkInfo;
        await expect(client.getEvents({ filters: [] })).rejects.toThrow();
        expect(
          methods.every((method) => method === "groundhog_networkInfo"),
        ).toBe(true);
      } finally {
        fetch.mockRestore();
      }
    },
  );
});

describe("resolveReadRpcUrl", () => {
  it("always uses the same-origin proxy in registry-enabled browser mode", () => {
    expect(
      resolveReadRpcUrl(
        {
          registryEnabled: true,
          rpcUrl: new URL("https://rpc.example.com/path"),
        },
        "https://launchpad.example.com",
      ),
    ).toBe("https://launchpad.example.com/groundhog-rpc");
  });

  it("preserves disabled browser and non-browser behavior", () => {
    const remote = {
      registryEnabled: false,
      rpcUrl: new URL("https://rpc.example.com"),
    };
    expect(resolveReadRpcUrl(remote, "https://launchpad.example.com")).toBe(
      "https://rpc.example.com/",
    );
    expect(resolveReadRpcUrl(remote)).toBe("https://rpc.example.com/");
    expect(
      resolveReadRpcUrl(
        {
          registryEnabled: false,
          rpcUrl: new URL("http://127.0.0.1:9545"),
        },
        "http://localhost:5173",
      ),
    ).toBe("http://localhost:5173/groundhog-rpc");
  });
});
