import { hashContract, toHex0x } from "@groundhogchain/client";
import { ContractType } from "@groundhogchain/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPoolTokenArtifact } from "./pool-token-artifact";

const contract = {
  contract_type: ContractType.kRv32,
  rv32_contract: { data: new Uint8Array([1, 2, 3]) },
} as const;
const hash = toHex0x(hashContract(contract));
const artifact = { contractType: "rv32", data: "0x010203", hash };
afterEach(() => vi.unstubAllGlobals());

describe("pool token artifact", () => {
  it("fetches only the fixed same-origin path and verifies the actual contract hash", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(artifact)));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchPoolTokenArtifact(hash)).resolves.toEqual(contract);
    expect(fetch).toHaveBeenCalledWith(
      new URL(`/contract-artifacts/${hash}.json`, window.location.origin),
      expect.objectContaining({
        redirect: "error",
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([undefined, "https://evil.test/token.json", "0x01"])(
    "rejects missing or invalid configured hash %s before fetch",
    async (expected) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(fetchPoolTokenArtifact(expected)).rejects.toThrow(
        "VITE_POOL_TOKEN_HASH",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...artifact, extra: true },
    { contractType: "rv32", hash },
    { ...artifact, contractType: "other" },
    { ...artifact, data: "0x1" },
    { ...artifact, data: "0x010204" },
    { ...artifact, hash: `0x${"00".repeat(32)}` },
    null,
  ])("rejects malformed or tampered artifact %#", async (value) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(value))),
    );
    await expect(fetchPoolTokenArtifact(hash)).rejects.toThrow(
      /invalid|mismatch/,
    );
  });

  it("rejects unsuccessful responses and invalid JSON", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("<html>"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchPoolTokenArtifact(hash)).rejects.toThrow("unavailable");
    await expect(fetchPoolTokenArtifact(hash)).rejects.toThrow();
  });

  it.each([true, false])(
    "bounds and cancels oversized bodies (declared=%s)",
    async (declared) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          },
          cancel,
        }),
        declared
          ? { headers: { "content-length": String(8 * 1024 * 1024 + 1) } }
          : {},
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(fetchPoolTokenArtifact(hash)).rejects.toThrow("too large");
      expect(cancel).toHaveBeenCalled();
    },
  );
});
