import { useMemo, useSyncExternalStore } from "react";

/**
 * A JSON record in `localStorage` that every mounted hook can watch.
 *
 * A page remounts on an account switch while a wallet call is still running,
 * so a write from one copy of a hook must reach the copy on screen. A
 * `localStorage` write in the same tab fires no event, so this module tells
 * the watchers itself.
 */
const watchers = new Map<string, Set<() => void>>();

/** The stored text, or null when there is none or storage is blocked. */
function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // The browser can deny site storage. Reads then show no record; writes
    // still throw, so a transaction whose record cannot be saved is not sent.
    return null;
  }
}

export function readRecord(key: string): unknown {
  try {
    return JSON.parse(readText(key) ?? "null");
  } catch {
    // Unreadable storage is treated as no record.
    return null;
  }
}

/** Save a record, or remove it with `null`, and tell every watcher. */
export function writeRecord(key: string, value: unknown) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
  watchers.get(key)?.forEach((notify) => notify());
}

/** The record under `key`, read with `parse`; it updates on every write. */
export function useRecord<T>(key: string, parse: (value: unknown) => T | null): T | null {
  const raw = useSyncExternalStore(
    (notify) => {
      const set = watchers.get(key) ?? new Set();
      watchers.set(key, set.add(notify));
      return () => set.delete(notify);
    },
    () => readText(key),
  );
  return useMemo(() => parse(readRecord(key)), [key, raw]);
}
