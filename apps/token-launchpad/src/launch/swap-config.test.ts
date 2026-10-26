import { describe, expect, it } from "vitest";
import { loadSwapAppUrl } from "./swap-config.ts";

describe("optional Swap origin", () => {
  it("preserves a hosted app base path", () => {
    expect(loadSwapAppUrl("https://examples.test/swap/")).toBe(
      "https://examples.test/swap/",
    );
  });
  it.each([undefined, "", "  "])("disables absent/blank %s", (value) => {
    expect(loadSwapAppUrl(value)).toBeNull();
  });
  it.each([
    "https://SWAP.example.test:443/",
    "http://localhost:5173/",
    "http://127.0.0.1:5173",
    "http://[::1]:5173/",
  ])("normalizes %s", (value) => {
    expect(loadSwapAppUrl(value)).toBe(new URL(value).origin);
  });
  it.each([
    false,
    "http://swap.test",
    "http://127.1",
    "http://2130706433",
    "http://localhost.",
    "//swap.test",
    "ftp://swap.test",
    "https://swap.test/pools/new",
    "https://swap.test/a/..",
    "https://swap.test/%2e/",
    "https://swap.test/?",
    "https://swap.test/#",
    "https://user:secret@swap.test",
    "https://@swap.test",
    "https://swap.test\\",
    "https://sw\tap.test",
    " https://swap.test",
    "https://swap.test/\n",
  ])("rejects %s", (value) => {
    expect(() => loadSwapAppUrl(value)).toThrow(/VITE_SWAP_APP_URL/);
  });
});
