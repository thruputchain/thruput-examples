import { describe, expect, it } from "vitest";
import { DEMO_DROP, validateDefinition, type DropDefinition } from "./drops";

const change = (edit: (d: DropDefinition) => void) => {
  const copy: DropDefinition = structuredClone(DEMO_DROP);
  edit(copy);
  return validateDefinition(copy);
};

describe("validateDefinition", () => {
  it("accepts the demo drop", () => {
    expect(validateDefinition(DEMO_DROP)).toBeNull();
  });

  it("explains each limit the contract enforces", () => {
    expect(change((d) => (d.name = " "))).toMatch(/name/);
    expect(change((d) => (d.symbol = "TOOLONGSYMBOL"))).toMatch(/symbol/);
    expect(change((d) => (d.supply = 0n))).toMatch(/supply/);
    expect(change((d) => (d.supply = 10_001n))).toMatch(/supply/);
    expect(change((d) => (d.traits = []))).toMatch(/traits/);
    expect(change((d) => (d.traits[1]!.name = "Palette"))).toMatch(/different/);
    expect(
      change((d) => (d.traits[0]!.values = [d.traits[0]!.values[0]!])),
    ).toMatch(/2–8 values/);
    expect(change((d) => (d.traits[0]!.values[0]!.weight = 0n))).toMatch(
      /Weights/,
    );
    expect(change((d) => (d.traits[0]!.values[1]!.name = "Bauhaus"))).toMatch(
      /different/,
    );
  });
});
