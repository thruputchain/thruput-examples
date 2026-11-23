import { describe, expect, it, vi } from "vitest";
import { toBase58, type ConnectedThruputClient } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { emptySnapshot, runRush, type RushOptions } from "./rush";

type Status = { status: string; blockHeight?: bigint };

/** A node stand-in. `status` decides what each status read returns. */
function fakeClient(handlers: {
  send?: (hash: string) => Promise<unknown>;
  status: (hash: string, reads: number) => Status | Promise<Status>;
}) {
  const reads = new Map<string, number>();
  const sent: string[] = [];
  const client = {
    discovery: { network: { networkHash: new Uint8Array(32) } },
    requireMethods: () => undefined,
    getBalance: vi.fn(),
    getChainTip: vi.fn(async () => ({ blockHeight: 1n })),
    sendTransaction: vi.fn(
      async ({ signedTransaction }: { signedTransaction: Uint8Array }) => {
        sent.push(toBase58(signedTransaction));
        return handlers.send?.(toBase58(signedTransaction));
      },
    ),
    getTransactionStatus: vi.fn(
      async ({ transactionHash }: { transactionHash: Uint8Array }) => {
        const hash = toBase58(transactionHash);
        const count = (reads.get(hash) ?? 0) + 1;
        reads.set(hash, count);
        return handlers.status(hash, count);
      },
    ),
    getTransactionReceipt: vi.fn(async () => ({
      blockHeight: 5n,
      execution: { result: "return" },
    })),
  };
  return { client: client as unknown as ConnectedThruputClient, sent };
}

async function rush(client: ConnectedThruputClient, users: number) {
  const options: RushOptions = {
    client,
    seed: new Uint8Array(32).fill(3),
    drop: contractAddress(new Uint8Array(32).fill(4)),
    users,
    windowSeconds: 0,
    id: 1,
  };
  const snapshot = emptySnapshot(options);
  await runRush(options, snapshot);
  return snapshot;
}

describe("runRush", () => {
  it("keeps observing a mint whose send failed, and counts it if it commits", async () => {
    const { client } = fakeClient({
      send: () => Promise.reject(new Error("timed out")),
      status: () => ({ status: "committed", blockHeight: 5n }),
    });
    const snapshot = await rush(client, 3);
    expect(snapshot.phase).toBe("done");
    expect(snapshot.outcomes).toMatchObject({ minted: 3, notIncluded: 0 });
  });

  it("does not fail the rush when one status read fails", async () => {
    const { client } = fakeClient({
      status: (_hash, reads) => {
        if (reads === 1) throw new Error("connection reset");
        return { status: "committed", blockHeight: 5n };
      },
    });
    const snapshot = await rush(client, 2);
    expect(snapshot.phase).toBe("done");
    expect(snapshot.outcomes.minted).toBe(2);
  });

  it("resends the same signed bytes after a block excludes a mint", async () => {
    const { client, sent } = fakeClient({
      status: (_hash, reads) =>
        reads === 1
          ? { status: "retry" }
          : { status: "committed", blockHeight: 6n },
    });
    const snapshot = await rush(client, 1);
    expect(snapshot.outcomes.minted).toBe(1);
    expect(snapshot.resubmitted).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });
});
