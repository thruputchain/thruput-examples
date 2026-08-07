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
  it("isolates temporary development-wallet authorization", () => {
    const allowedModule = "./transactions/local-development-wallet.ts";
    const forbidden = [
      "PrivateKeySigner",
      "GROUNDHOG_DEV_PRIVATE_KEY",
      "GROUNDHOG_WALLET_ENTRYPOINT",
      "doAction",
      "do_action",
    ];
    const offenders = Object.entries(browserModules)
      .filter(([path, source]) =>
        path !== allowedModule && forbidden.some((value) => source.includes(value)),
      )
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("does not expose the complete Vite environment to configuration parsing", () => {
    const offenders = Object.entries(browserModules)
      .filter(([, source]) => source.includes("loadAppConfig(import.meta.env)"))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
