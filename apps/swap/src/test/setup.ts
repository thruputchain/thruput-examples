import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const localValues = new Map<string, string>();
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
    value: {
      request: async (
        name: string,
        options: LockOptions,
        callback: (lock: Lock) => Promise<unknown>,
      ) => {
        return callback({ name, mode: options.mode ?? "exclusive" });
      },
    },
  });
}

afterEach(cleanup);
