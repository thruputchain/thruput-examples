import { hashContract, toHex0x } from "@groundhogchain/client";
import { ContractType } from "@groundhogchain/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { loadStandardTokenArtifact } from "./token-artifact";

const contract = {
  contract_type: ContractType.kRv32,
  rv32_contract: { data: new Uint8Array([1, 2, 3]) },
} as const;
const hash = hashContract(contract);
const artifact = {
  contractType: "rv32",
  data: "0x010203",
  hash: toHex0x(hash),
};
afterEach(() => vi.unstubAllGlobals());
it("fetches a fixed same-origin asset with a timeout and redirect rejection", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(artifact)));
  vi.stubGlobal("fetch", fetch);
  expect(await loadStandardTokenArtifact(hash)).toEqual(contract);
  expect(fetch).toHaveBeenCalledWith(
    new URL(
      `/contract-artifacts/${toHex0x(hash)}.json`,
      window.location.origin,
    ),
    expect.objectContaining({
      mode: "same-origin",
      redirect: "error",
      signal: expect.any(AbortSignal),
    }),
  );
});
it.each([
  { ...artifact, contractType: "wasm" },
  { ...artifact, data: "0x01z" },
  { ...artifact, data: "0x010204" },
  { ...artifact, hash: `0x${"00".repeat(32)}` },
  null,
])("rejects malformed or mismatched code %j", async (value) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(value))),
  );
  await expect(loadStandardTokenArtifact(hash)).rejects.toThrow();
});
it("bounds streamed bytes even without content-length", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))),
  );
  await expect(loadStandardTokenArtifact(hash)).rejects.toThrow(/too large/);
});
it("rejects missing assets rather than signing without code", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Not found", { status: 404 })),
  );
  await expect(loadStandardTokenArtifact(hash)).rejects.toThrow(/unavailable/);
});
