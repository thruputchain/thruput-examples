import { describe, expect, it } from "vitest";

const browserModules = import.meta.glob<string>(
  [
    "./**/*.{ts,tsx}",
    "!./**/*.test.{ts,tsx}",
    "!./contracts/generated/**",
  ],
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
);

describe("browser dependency boundary", () => {
  it.each([
    "PrivateKeySigner",
    "GROUNDHOG_DEV_PRIVATE_KEY",
    "GROUNDHOG_WALLET_ENTRYPOINT",
    "loadAppConfig(import.meta.env)",
    "doAction",
    "do_action",
  ])("does not include %s", (forbidden) => {
    const offenders = Object.entries(browserModules)
      .filter(([, source]) => source.includes(forbidden))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
