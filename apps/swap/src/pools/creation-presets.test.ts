import { describe, expect, it } from "vitest";
import { readCreationPresets } from "./creation-presets";

const a = `0x${"ab".repeat(32)}`;
const b = `0x${"cd".repeat(32)}`;

describe("creation link presets", () => {
  it.each([
    ["", "", ""],
    [`?tokenA=${a}`, a, ""],
    [`?tokenB=${b}`, "", b],
    [`?tokenA=${b}&tokenB=${a}`, b, a],
    [`?tokenA=0x${"AB".repeat(32)}`, a, ""],
    [`?TokenA=${a}&amountA=5&callback=https://example.com`, "", ""],
  ])("seeds only address slots: %s", (query, tokenA, tokenB) => {
    expect(readCreationPresets(query)).toEqual({
      tokenA,
      tokenB,
      warnings: [],
    });
  });

  it.each([
    "",
    "bad",
    `0x${"0".repeat(64)}`,
    a.slice(2),
    `0X${"ab".repeat(32)}`,
    `${a}&tokenA=${a}`,
  ])("rejects invalid or repeated A without losing B: %s", (value) => {
    expect(readCreationPresets(`?tokenA=${value}&tokenB=${b}`)).toEqual({
      tokenA: "",
      tokenB: b,
      warnings: [expect.stringContaining("tokenA preset was ignored")],
    });
  });

  it("rejects repeated B and canonical duplicates", () => {
    expect(
      readCreationPresets(`?tokenA=${a}&tokenB=${b}&tokenB=${b}`),
    ).toMatchObject({ tokenA: a, tokenB: "", warnings: [expect.any(String)] });
    expect(
      readCreationPresets(`?tokenA=${a}&tokenB=0x${"AB".repeat(32)}`),
    ).toMatchObject({
      tokenA: a,
      tokenB: "",
      warnings: [expect.stringContaining("different contract")],
    });
  });
});
