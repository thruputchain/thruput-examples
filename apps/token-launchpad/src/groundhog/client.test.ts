import { describe, expect, it } from "vitest";

import { resolveReadRpcUrl } from "@/groundhog/client";

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
