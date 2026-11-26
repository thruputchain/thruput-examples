import { setTimeout as delay } from "node:timers/promises";
import { isThruputError } from "@thruputchain/client";

// A committed receipt can arrive before the read snapshot catches up.
// Callers set minStateBlockHeight to the receipt height. Retry only that lagging read;
// never retry signing or submission here.
export async function waitForView<T>(read: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (
        !isThruputError(error, "nativeRpcError") ||
        error.context.kind !== "stateHeightUnavailable" ||
        Date.now() >= deadline
      )
        throw error;
      await delay(100);
    }
  }
}
