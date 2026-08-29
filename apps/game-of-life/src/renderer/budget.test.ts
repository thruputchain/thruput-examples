import { describe, expect, test } from "vitest";
import { ActiveByteBudget } from "./budget";

describe("active GPU byte budget", () => {
  test("never evicts a live owner and releases each reservation once", () => {
    const budget = new ActiveByteBudget(10);
    const release = budget.reserve(7);
    expect(() => budget.reserve(4)).toThrow(/exceed/);
    expect(budget.byteLength).toBe(7);
    release();
    release();
    expect(budget.byteLength).toBe(0);
    expect(() => budget.reserve(10)).not.toThrow();
  });
});
