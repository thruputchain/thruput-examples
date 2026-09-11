// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createPubkeyAccount,
  hashSignedTransaction,
  PrivateKeySigner,
  toHex0x,
  type EmittedEvent,
  type EventPage,
  type EventQuery,
  type TransactionReceipt,
} from "@groundhogchain/client";
import {
  createTransaction,
  signTransaction,
} from "@groundhogchain/client/transaction";
import {
  blockHeight,
  contractAddress,
  ExecResult,
  gasAmount,
  networkHash,
  sha256Hash,
} from "@groundhogchain/protocol";
import { CxsWriter, Uint128Codec } from "@groundhogchain/xdr";
import {
  SwapDriver,
  RequestFailed,
} from "../../apps/swap/src/contracts/generated/swap-driver.ts";
import { MintEvent } from "../../apps/swap/src/contracts/generated/swap-handler.ts";
import { executeStep, type SeedJournal } from "./seed-journal.ts";
import {
  completeSeedLiquidity,
  type LiquidityProgress,
} from "./seed-liquidity.ts";

const address = (byte: number) =>
  contractAddress(new Uint8Array(32).fill(byte));
const handler = address(2),
  driver = address(3),
  recipient = address(4);
const requestId = new Uint8Array(32).fill(5);
const queued: TransactionReceipt = {
  txHash: sha256Hash(new Uint8Array(32).fill(6)),
  height: 10n,
  execResult: ExecResult.ExecResultOK,
  events: [],
  returnData: null,
  abortData: null,
};
type State = SeedJournal & { liquidity?: LiquidityProgress };

function fixture(terminalAt = 2, failed = false) {
  const signer = new PrivateKeySigner(new Uint8Array(32).fill(1));
  const account = createPubkeyAccount({ signer });
  const state: State = { steps: {} };
  const receipts = new Map<string, TransactionReceipt>();
  const mint = (): EmittedEvent => {
    const writer = new CxsWriter();
    Uint128Codec.encode(writer, 100n);
    writer.writeUint32(1n);
    writer.writeFixedOpaque(requestId, 32);
    return {
      contractAddress: handler,
      topics: [MintEvent.signature, account.address, recipient],
      data: writer.finish(),
    };
  };
  const failure = (): EmittedEvent => ({
    contractAddress: driver,
    topics: [RequestFailed.signature, requestId],
    data: new Uint8Array(),
  });
  const terminalEvent = failed ? failure : mint;
  let nonce = 0n;
  const client = {
    getEvents: vi.fn(async (_query: EventQuery): Promise<EventPage> => ({
      events: [],
      cursor: new Uint8Array(),
      latestBlock: 100n,
      oldestBlock: 0n,
    })),
    getTransactionReceipt: vi.fn(
      async (hash: Uint8Array) => receipts.get(toHex0x(hash)) ?? null,
    ),
    getTransactionStatus: vi.fn(async () => ({ status: "pending" as const })),
    getChainTip: vi.fn(async () => ({
      height: blockHeight(50n),
      blockHash: queued.txHash,
    })),
    sendTransaction: vi.fn(
      async (signed: Awaited<ReturnType<typeof signTransaction>>) => {
        const hash = hashSignedTransaction(signed);
        const index = receipts.size + 1;
        receipts.set(toHex0x(hash), {
          ...queued,
          txHash: hash,
          height: queued.height + BigInt(index),
          events: index === terminalAt ? [terminalEvent()] : [],
        });
        return hash;
      },
    ),
    waitForTransactionReceipt: vi.fn(async (hash: Uint8Array) =>
      receipts.get(toHex0x(hash))!,
    ),
  };
  const save = vi.fn(async () => {});
  const prepare = vi.fn(async () =>
    signTransaction(
      createTransaction({
        invocation: SwapDriver.processRequests.invocation(
          driver,
          gasAmount(10_000_000n),
        ),
        uniquifier: { nonce: ++nonce, block_expiry_height: blockHeight(100n) },
        contracts_to_deploy: [],
        auth_claim: account.authClaim,
      }),
      [{ signer, publicKeyId: 0n }],
      networkHash(sha256Hash(new Uint8Array(32).fill(7))),
    ),
  );
  const crank = (name: string, journal: State = state) =>
    executeStep({ name, intent: name, journal, save, client, prepare });
  const run = (journal: State = state) =>
    completeSeedLiquidity({
      state: journal,
      save,
      client,
      queued,
      requestId,
      handler,
      driver,
      signer: account.address,
      recipient,
      crank: (name) => crank(name, journal),
    });
  return { state, client, save, prepare, receipts, run, crank, terminalEvent };
}

describe("seed liquidity request completion", () => {
  it("continues after a successful zero-result crank, then persists the second crank's correlated mint", async () => {
    const f = fixture();
    await f.run();
    expect(Object.keys(f.state.steps)).toEqual([
      "process-liquidity-1",
      "process-liquidity-2",
    ]);
    expect(f.state.liquidity).toMatchObject({
      requestId: toHex0x(requestId),
      queueTransactionHash: toHex0x(queued.txHash),
      anchorBlock: "10",
      terminal: { kind: "minted", blockHeight: "12" },
    });
    expect(f.client.sendTransaction).toHaveBeenCalledTimes(2);
    const restarted = JSON.parse(JSON.stringify(f.state)) as State;
    await f.run(restarted);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.client.sendTransaction).toHaveBeenCalledTimes(2);
    expect(restarted).toEqual(f.state);
  });

  it("bounds new cranks per invocation and continues numbering after a restart without repeating committed sends", async () => {
    const f = fixture(5);
    await expect(f.run()).rejects.toThrow("four additional cranks");
    expect(f.client.sendTransaction).toHaveBeenCalledTimes(4);
    expect(f.state.liquidity?.terminal).toBeUndefined();
    await f.run(JSON.parse(JSON.stringify(f.state)) as State);
    expect(f.client.sendTransaction).toHaveBeenCalledTimes(5);
    expect(f.prepare).toHaveBeenCalledTimes(5);
  });

  it("recovers the legacy successful single-crank step before adding numbered cranks", async () => {
    const f = fixture();
    await f.crank("process-liquidity");
    await f.run();
    expect(Object.keys(f.state.steps)).toEqual([
      "process-liquidity",
      "process-liquidity-1",
    ]);
    expect(f.client.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("records RequestFailed as terminal and refuses more cranks on rerun", async () => {
    const f = fixture(1, true);
    await expect(f.run()).rejects.toThrow("Liquidity request failed");
    expect(f.state.liquidity?.terminal?.kind).toBe("failed");
    await expect(
      f.run(JSON.parse(JSON.stringify(f.state)) as State),
    ).rejects.toThrow("will not be enqueued or cranked again");
    expect(f.client.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "observes externally processed terminal events across anchored pages before cranking (failed=%s)",
    async (failed) => {
      const f = fixture(1, failed);
      const receipt = {
        ...queued,
        txHash: sha256Hash(new Uint8Array(32).fill(8)),
        height: 11n,
        events: [f.terminalEvent()],
      };
      f.receipts.set(toHex0x(receipt.txHash), receipt);
      f.client.getEvents.mockResolvedValueOnce({
        events: [],
        cursor: new Uint8Array([1]),
        latestBlock: 20n,
        oldestBlock: 0n,
      });
      f.client.getEvents.mockResolvedValueOnce({
        events: [
          {
            txHash: receipt.txHash,
            blockHeight: receipt.height,
            sequenceNumber: 0,
            event: receipt.events[0]!,
          },
        ],
        cursor: new Uint8Array(),
        latestBlock: 20n,
        oldestBlock: 0n,
      });
      if (failed)
        await expect(f.run()).rejects.toThrow("Liquidity request failed");
      else await f.run();
      expect(f.client.sendTransaction).not.toHaveBeenCalled();
      for (const [query] of f.client.getEvents.mock.calls)
        expect(query).toMatchObject({ anchor: { height: queued.height } });
      expect(f.client.getEvents.mock.calls[1]?.[0]).toMatchObject({
        cursor: new Uint8Array([1]),
      });
    },
  );

  it("stops on incomplete history, instead of assuming the request still needs a crank", async () => {
    const f = fixture();
    f.client.getEvents.mockResolvedValue({
      events: [],
      cursor: new Uint8Array(),
      latestBlock: 100n,
      oldestBlock: 11n,
    });
    await expect(f.run()).rejects.toThrow("history incomplete");
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });

  it("blocks a changed request anchor before any crank", async () => {
    const f = fixture();
    f.state.liquidity = {
      requestId: toHex0x(requestId),
      queueTransactionHash: toHex0x(queued.txHash),
      anchorBlock: "9",
    };
    await expect(f.run()).rejects.toThrow("identity changed");
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });
});
