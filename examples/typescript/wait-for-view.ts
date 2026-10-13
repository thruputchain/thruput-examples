import { setTimeout as delay } from "node:timers/promises";
import { JsonRpcError, ThruputRpcErrorCode } from "@thruputchain/client";

// A committed receipt can arrive before the read snapshot catches up.
// Callers set minHeight to the receipt height. Retry only that lagging read;
// never retry signing or submission here.
export async function waitForView<T>(read: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (
        !(error instanceof JsonRpcError) ||
        error.code !== ThruputRpcErrorCode.ViewHeightUnavailable ||
        Date.now() >= deadline
      )
        throw error;
      await delay(100);
    }
  }
}
