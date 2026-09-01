import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const locks = {
  request: async <T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock) => Promise<T>,
  ) => callback({ name, mode: options.mode ?? "exclusive" }),
};

if (typeof window !== "undefined")
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });

afterEach(() => {
  cleanup();
  if (typeof window !== "undefined") {
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: locks,
    });
  }
});
