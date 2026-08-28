import { describe, expect, it } from "vitest";

import { userErrorMessage } from "@/errors";

describe("userErrorMessage", () => {
  it("bounds and redacts untrusted error content", () => {
    const secret = `0x${"ab".repeat(64)}`;
    const message = userErrorMessage(
      new Error(`${secret} ${"upstream".repeat(100)}`),
      "fallback",
    );
    expect(message).not.toContain(secret);
    expect(message.length).toBeLessThanOrEqual(300);
  });

  it("uses the fallback for non-errors", () => {
    expect(userErrorMessage({ raw: "rpc body" }, "Request failed")).toBe(
      "Request failed",
    );
  });
});
