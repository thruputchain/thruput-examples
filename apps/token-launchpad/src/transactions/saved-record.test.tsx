// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readRecord, useRecord, writeRecord } from "./saved-record";

afterEach(() => vi.unstubAllGlobals());

it("shows no record when the browser blocks storage, and still refuses to write", () => {
  const blocked = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  vi.stubGlobal("localStorage", {
    getItem: blocked,
    setItem: blocked,
    removeItem: blocked,
  });
  const { result } = renderHook(() => useRecord("key", (value) => value));
  expect(result.current).toBeNull();
  expect(readRecord("key")).toBeNull();
  // A transaction whose record cannot be saved must not be sent.
  expect(() => writeRecord("key", { hash: "h" })).toThrow(/insecure/);
});
