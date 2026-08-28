import { fixedBytes } from "@groundhogchain/client";
import { describe, expect, it } from "vitest";

import type { FactoryConfig } from "@/contracts/generated/standard-token-factory";
import {
  assertTrustedFactoryConfig,
  calculateFundingAmount,
  safeDisplayDecimals,
} from "@/contracts/launchpad-client";
import { configuration } from "@/launch/workflow.test";
import { MAX_SIGNED_AMOUNT } from "@/runtime";

describe("factory review", () => {
  const config = configuration();
  const trusted: FactoryConfig = {
    native_token: config.nativeHogAddress,
    token_code_hash: fixedBytes(config.expectedTokenHash, 32),
    required_token_funding: 100n,
    creation_fee: 0n,
    fee_recipient: null,
  };

  it("accepts only the pinned zero-fee factory configuration", () => {
    expect(() => assertTrustedFactoryConfig(trusted, config)).not.toThrow();
    expect(() =>
      assertTrustedFactoryConfig(
        { ...trusted, required_token_funding: MAX_SIGNED_AMOUNT + 1n },
        config,
      ),
    ).toThrow(/could not be verified/);
    expect(() =>
      assertTrustedFactoryConfig({ ...trusted, creation_fee: 1n }, config),
    ).toThrow(/could not be verified/);
    expect(() =>
      assertTrustedFactoryConfig(
        {
          ...trusted,
          token_code_hash: fixedBytes(new Uint8Array(32).fill(1), 32),
        },
        config,
      ),
    ).toThrow(/could not be verified/);
  });

  it("calculates reserve deficits without charging an existing balance item", () => {
    expect(calculateFundingAmount(100n, 0n, 10n, false)).toBe(110n);
    expect(calculateFundingAmount(100n, 0n, 10n, true)).toBe(100n);
    expect(calculateFundingAmount(100n, 40n, 10n, false)).toBe(60n);
    expect(calculateFundingAmount(100n, 100n, 10n, false)).toBe(0n);
  });

  it("rejects a transfer outside the signed amount bound", () => {
    expect(() =>
      calculateFundingAmount(MAX_SIGNED_AMOUNT, 0n, 1n, false),
    ).toThrow(/amount limit/);
  });

  it("rejects impractical on-chain decimals for display", () => {
    expect(safeDisplayDecimals(18n)).toBe(18);
    expect(safeDisplayDecimals(19n)).toBeNull();
    expect(safeDisplayDecimals((1n << 32n) - 1n)).toBeNull();
  });
});
