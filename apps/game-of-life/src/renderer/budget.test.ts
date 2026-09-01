import { describe, expect, test } from "vitest";
import {
  ActiveByteBudget,
  ByteBudget,
  DECK_LAYER_CACHE_BUDGET,
  DEFAULT_CPU_BUDGET,
  SHARED_CPU_CACHE_BUDGET,
} from "./budget";

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

describe("aggregate CPU byte budget", () => {
  test("shared and dual deck caches total no more than 64 MiB", () => {
    expect(SHARED_CPU_CACHE_BUDGET + 2 * DECK_LAYER_CACHE_BUDGET).toBe(
      DEFAULT_CPU_BUDGET,
    );
  });

  test("pins displayed data against candidate cache pressure", () => {
    const cache = new ByteBudget<string>(10);
    cache.set("displayed", "old", 6);
    cache.pin("displayed");
    cache.set("candidate", "new", 6);
    expect(cache.get("displayed")).toBe("old");
    expect(cache.get("candidate")).toBeUndefined();
    cache.unpin("displayed");
    cache.set("candidate", "new", 6);
    expect(cache.get("candidate")).toBe("new");
  });
});
