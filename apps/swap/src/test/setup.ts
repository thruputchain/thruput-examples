import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const localValues = new Map<string, string>();
const defaultLocks = {
  request: async (
    name: string,
    options: LockOptions,
    callback: (lock: Lock) => Promise<unknown>,
  ) => callback({ name, mode: options.mode ?? "exclusive" }),
};
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return localValues.size;
      },
      clear: () => localValues.clear(),
      getItem: (key: string) => localValues.get(key) ?? null,
      key: (index: number) => [...localValues.keys()][index] ?? null,
      removeItem: (key: string) => localValues.delete(key),
      setItem: (key: string, value: string) => localValues.set(key, String(value)),
    } satisfies Storage,
  });

  Object.defineProperty(window.navigator, "locks", {
    configurable: true,
    value: defaultLocks,
  });
}

afterEach(() => {
  cleanup();
  if (typeof window !== "undefined") {
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: defaultLocks,
    });
  }
});
