import {
  bytesEqual,
  fixedBytes,
  fromHex0x,
  toHex0x,
  type EmittedEvent,
  type GroundhogClient,
  type TransactionReceipt,
} from "@groundhogchain/client";
import {
  ExecResult,
  sha256Hash,
  type ContractAddress,
} from "@groundhogchain/protocol";
import { RequestFailed } from "../../apps/swap/src/contracts/generated/swap-driver.ts";
import { MintEvent } from "../../apps/swap/src/contracts/generated/swap-handler.ts";
import { SeedError, type SeedJournal } from "./seed-journal.ts";

interface Terminal {
  kind: "minted" | "failed";
  transactionHash: string;
  blockHeight: string;
}

export interface LiquidityProgress {
  requestId: string;
  queueTransactionHash: string;
  anchorBlock: string;
  terminal?: Terminal;
}

interface LiquidityState extends SeedJournal {
  liquidity?: LiquidityProgress;
}

/** A successful crank is not a successful request. Only correlated terminal evidence completes it. */
export async function completeSeedLiquidity(options: {
  state: LiquidityState;
  save: () => Promise<void>;
  client: Pick<GroundhogClient, "getEvents" | "getTransactionReceipt">;
  queued: TransactionReceipt;
  requestId: Uint8Array;
  handler: ContractAddress;
  driver: ContractAddress;
  signer: ContractAddress;
  recipient: ContractAddress;
  crank: (name: string) => Promise<TransactionReceipt>;
}): Promise<void> {
  const {
    state,
    client,
    queued,
    requestId,
    handler,
    driver,
    signer,
    recipient,
  } = options;
  const identity = {
    requestId: toHex0x(requestId),
    queueTransactionHash: toHex0x(queued.txHash),
    anchorBlock: queued.height.toString(),
  };
  if (!state.liquidity) {
    state.liquidity = identity;
    await options.save();
  }
  const progress = state.liquidity;
  if (
    progress.requestId !== identity.requestId ||
    progress.queueTransactionHash !== identity.queueTransactionHash ||
    progress.anchorBlock !== identity.anchorBlock
  ) {
    throw new SeedError("Liquidity request identity changed");
  }
  const terminalKind = (event: EmittedEvent): Terminal["kind"] | null => {
    if (bytesEqual(event.contractAddress, handler)) {
      const mint = MintEvent.decode(event);
      if (
        mint?.fields.request_id &&
        bytesEqual(mint.fields.request_id, requestId)
      ) {
        if (
          !bytesEqual(mint.topics.sender, signer) ||
          !bytesEqual(mint.topics.recipient, recipient) ||
          mint.fields.amount_minted <= 0n
        )
          throw new SeedError("Invalid liquidity mint evidence");
        return "minted";
      }
    }
    if (bytesEqual(event.contractAddress, driver)) {
      const failed = RequestFailed.decode(event);
      if (failed && bytesEqual(failed.topics.request_id, requestId))
        return "failed";
    }
    return null;
  };
  const fromReceipt = (receipt: TransactionReceipt): Terminal | undefined => {
    if (
      receipt.execResult !== ExecResult.ExecResultOK ||
      receipt.height < queued.height
    )
      throw new SeedError("Invalid liquidity terminal receipt");
    const matches = receipt.events
      .map(terminalKind)
      .filter((kind) => kind !== null);
    if (matches.length > 1)
      throw new SeedError("Duplicate liquidity terminal evidence");
    return matches[0]
      ? {
          kind: matches[0],
          transactionHash: toHex0x(receipt.txHash),
          blockHeight: receipt.height.toString(),
        }
      : undefined;
  };
  const finish = async (terminal: Terminal): Promise<void> => {
    if (!progress.terminal) {
      progress.terminal = terminal;
      await options.save();
    }
    if (terminal.kind === "failed")
      throw new SeedError(
        `Liquidity request failed in ${terminal.transactionHash}; it will not be enqueued or cranked again`,
      );
  };
  const verifyTerminal = async (terminal: Terminal): Promise<void> => {
    const receipt = await client.getTransactionReceipt(
      sha256Hash(fromHex0x(terminal.transactionHash)),
    );
    if (!receipt || toHex0x(receipt.txHash) !== terminal.transactionHash)
      throw new SeedError(
        "Liquidity terminal receipt unavailable or mismatched",
      );
    const actual = fromReceipt(receipt);
    if (
      !actual ||
      actual.kind !== terminal.kind ||
      actual.blockHeight !== terminal.blockHeight
    )
      throw new SeedError("Liquidity terminal evidence changed");
    await finish(actual);
  };
  if (progress.terminal) return verifyTerminal(progress.terminal);

  const observe = async (through: bigint): Promise<boolean> => {
    let cursor: Uint8Array | undefined;
    let terminal: Terminal | undefined;
    const cursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await client.getEvents({
        filters: [
          MintEvent.filter({ contractAddresses: [handler] }),
          RequestFailed.filter({
            contractAddresses: [driver],
            topics: { request_id: fixedBytes(requestId, 32) },
          }),
        ],
        order: "ascending",
        anchor: { height: queued.height },
        ...(cursor ? { cursor } : {}),
        limit: 200,
      });
      if (page.oldestBlock > queued.height || page.latestBlock < through)
        throw new SeedError(
          "Liquidity event history incomplete or not caught up; rerun to observe before cranking",
        );
      for (const event of page.events) {
        const kind = terminalKind(event.event);
        if (!kind) continue;
        if (terminal)
          throw new SeedError("Duplicate liquidity terminal evidence");
        terminal = {
          kind,
          transactionHash: toHex0x(event.txHash),
          blockHeight: event.blockHeight.toString(),
        };
      }
      if (page.cursor.length === 0) {
        if (!terminal) return false;
        await verifyTerminal(terminal);
        return true;
      }
      const key = toHex0x(page.cursor);
      if (cursors.has(key))
        throw new SeedError("Repeated liquidity event cursor");
      cursors.add(key);
      cursor = page.cursor;
    }
    throw new SeedError(
      "Incomplete liquidity event scan; no additional crank submitted",
    );
  };

  if (await observe(queued.height)) return;
  let newCranks = 0;
  // Reconcile the original single-step journal, if present, before numbered steps.
  for (let index = state.steps["process-liquidity"] ? 0 : 1; ; index++) {
    const name =
      index === 0 ? "process-liquidity" : `process-liquidity-${index}`;
    if (!state.steps[name]?.length) {
      if (newCranks === 4)
        throw new SeedError(
          "Liquidity request still pending after four additional cranks; rerun to continue observing the same request",
        );
      newCranks++;
    }
    const receipt = await options.crank(name);
    const terminal = fromReceipt(receipt);
    if (terminal) return finish(terminal);
    if (await observe(receipt.height)) return;
  }
}
