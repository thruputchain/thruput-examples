import { describe, expect, it } from "vitest";

import { resolveReadRpcUrl } from "./client";

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
