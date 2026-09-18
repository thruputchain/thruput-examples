import { describe, expect, it } from "vitest";
import { parseExplorerUrl } from "./explorer-url";

describe("explorer origin", () => {
  it.each([undefined, "", " \n "])(
    "disables absent or blank values: %s",
    (value) => {
      expect(parseExplorerUrl(value)).toBeNull();
    },
  );
  it.each([
    ["https://EXPLORER.test:443/", "https://explorer.test"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:3000/", "http://[::1]:3000"],
  ])("normalizes %s", (value, expected) =>
    expect(parseExplorerUrl(value)).toBe(expected),
  );
  it.each([
    true,
    false,
    "bad",
    "//example.test",
    "javascript:alert(1)",
    "http://remote.test",
    "http://127.1",
    "http://2130706433",
    "http://127.0.0.2",
    "http://localhost.evil.test",
    "http://localhost.",
    "http://0x7f000001",
    "https://user:secret@example.test",
    "https://@example.test",
    "https://example.test/path",
    "https://example.test/..",
    "https://example.test/?",
    "https://example.test/#",
    " https://example.test",
    "https://example.test\n",
    "https://example.test\\path",
    "https://",
    "https://example.test:99999",
  ])("rejects malformed or unsafe values: %s", (value) => {
    expect(() => parseExplorerUrl(value)).toThrow(/VITE_EXPLORER_URL/);
    expect(() => parseExplorerUrl(value)).not.toThrow(/secret/);
  });
});
