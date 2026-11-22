import {
  addressFromBase58,
  createThruputClient,
  createWalletClient,
  defineCluster,
  hashFromBase58,
  HttpTransport,
  hashSignedTransaction,
  serializeSignedTransaction,
  toBase58,
  type ConnectedThruputClient,
  type ContractAddress,
  type CoreThruputClient,
  type TransactionReceipt,
} from "@thruputchain/client";
import { blockHeight, networkHash } from "@thruputchain/protocol";
import { NftDrop, nft_drop } from "../src/contracts/generated/nft-drop";
import { dropAddresses } from "../src/contracts/drops";
import type { ServerConfig } from "./config";
import { crowdAccount, MINT_GAS } from "./crowd";

/**
 * A rush: one mint from each of `users` crowd accounts, each submitted at a
 * random time in the window.
 *
 * 1. Preparing: sign every mint first, so signing time is not chain time.
 * 2. Running: submit each mint at its arrival time.
 * 3. Settling: observe each original hash until it has an outcome, or until
 *    two minutes after the last submission.
 *
 * When a block excludes a mint, its status is `retry`. Each simulated user
 * then does what a wallet does: it resubmits the same signed transaction. No
 * new transaction is signed, so each user's mint can commit at most once.
 */
export type Phase = "preparing" | "running" | "settling" | "done" | "failed";

export interface Outcomes {
  /** Committed and returned a token. */
  minted: number;
  /** Committed with `SoldOut`: the supply was gone at the block's start. */
  soldOut: number;
  /** Not committed: dropped by the node, or still excluded at the deadline. */
  notIncluded: number;
  /** Committed with another failure. This indicates a problem. */
  failed: number;
  /** Not yet known. */
  pending: number;
}

export interface RushSnapshot {
  id: number;
  drop: string;
  users: number;
  windowSeconds: number;
  phase: Phase;
  message: string | null;
  signed: number;
  submitted: number;
  outcomes: Outcomes;
  /** Mints that landed in each block, in block order. */
  blocks: { height: string; minted: number }[];
  /** How many times a user resubmitted its excluded mint. */
  resubmitted: number;
  /**
   * Why a block excluded a mint, from advisory `recentFailure` reports.
   * `supply` (`boundsExceeded`) is the supply bound at sell-out. `funding`
   * (`insufficientFunds`) means the drop's storage funding was held for other
   * mints in that block. `other` would be a conflict between mints, which this
   * design should never produce.
   */
  exclusions: { supply: number; funding: number; other: number };
  /** Milliseconds from the first submission to the last submission. */
  submitMs: number | null;
  /** Milliseconds from the first submission until every outcome was known. */
  settledMs: number | null;
}

export interface RushOptions {
  /** Connected to the app's network; wallets sign for it. */
  client: ConnectedThruputClient;
  seed: Uint8Array;
  drop: ContractAddress;
  users: number;
  windowSeconds: number;
  id: number;
  onUpdate?: () => void;
}

const SOLD_OUT = nft_drop.v0_1.implementation.DropError.SoldOut;
const SETTLE_TIMEOUT_MS = 120_000;
// About one block: a resubmission waits for the next block before another.
const RESUBMIT_MS = 2_000;
const POLL_MS = 500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Entry {
  hash: Uint8Array;
  bytes: Uint8Array;
  at: number;
  outcome: keyof Outcomes;
  resubmittedAt: number;
}

export function emptySnapshot(
  options: Omit<RushOptions, "client" | "seed">,
): RushSnapshot {
  return {
    id: options.id,
    drop: toBase58(options.drop),
    users: options.users,
    windowSeconds: options.windowSeconds,
    phase: "preparing",
    message: null,
    signed: 0,
    submitted: 0,
    outcomes: {
      minted: 0,
      soldOut: 0,
      notIncluded: 0,
      failed: 0,
      pending: options.users,
    },
    blocks: [],
    resubmitted: 0,
    exclusions: { supply: 0, funding: 0, other: 0 },
    submitMs: null,
    settledMs: null,
  };
}

/** Run one rush, updating `snapshot` in place as it progresses. */
export async function runRush(
  options: RushOptions,
  snapshot: RushSnapshot,
): Promise<void> {
  const { client, seed, drop, users, windowSeconds } = options;
  const update = () => options.onUpdate?.();
  try {
    // 1. Sign every mint before the window opens.
    const tip = await client.getChainTip();
    const blockExpiryHeight = blockHeight(tip.blockHeight + 1_000n);
    const invocation = NftDrop.v0_1.mint.invocation(drop, MINT_GAS);
    const entries: Entry[] = [];
    for (let index = 0; index < users; index++) {
      const wallet = createWalletClient({
        client,
        account: crowdAccount(seed, index),
      });
      const transaction = await wallet.prepareExecution({
        invocation,
        gasLimit: MINT_GAS,
        blockExpiryHeight,
      });
      const signed = await wallet.signTransaction(transaction);
      entries.push({
        hash: hashSignedTransaction(signed),
        bytes: serializeSignedTransaction(signed),
        at: Math.random() * windowSeconds * 1_000,
        outcome: "pending",
        resubmittedAt: 0,
      });
      snapshot.signed = index + 1;
      if (index % 250 === 0) update();
    }
    entries.sort((a, b) => a.at - b.at);

    // 2. Release each mint at its arrival time.
    snapshot.phase = "running";
    update();
    const started = Date.now();
    const sends: Promise<void>[] = [];
    for (const entry of entries) {
      const wait = started + entry.at - Date.now();
      if (wait > 2) await sleep(wait);
      sends.push(
        client
          .sendTransaction({ signedTransaction: entry.bytes })
          .then(
            () => undefined,
            // A rejected submission never reaches a block.
            () => settle(entry, "notIncluded"),
          )
          .finally(() => {
            snapshot.submitted++;
          }),
      );
    }
    await Promise.all(sends);
    snapshot.submitMs = Date.now() - started;

    // 3. Observe every original hash until it has an outcome.
    snapshot.phase = "settling";
    update();
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let open = entries.filter((entry) => entry.outcome === "pending");
    while (open.length > 0 && Date.now() < deadline) {
      await Promise.all(open.map((entry) => observe(entry)));
      open = open.filter((entry) => entry.outcome === "pending");
      update();
      if (open.length > 0) await sleep(POLL_MS);
    }
    snapshot.settledMs = Date.now() - started;
    snapshot.phase = "done";
    snapshot.message =
      open.length > 0
        ? `${open.length} mints have no outcome yet. Their hashes may still commit.`
        : null;
  } catch (error) {
    snapshot.phase = "failed";
    snapshot.message = error instanceof Error ? error.message : String(error);
  }
  update();

  function settle(
    entry: Entry,
    outcome: keyof Outcomes,
    receipt?: TransactionReceipt,
  ) {
    if (entry.outcome !== "pending") return;
    entry.outcome = outcome;
    snapshot.outcomes.pending--;
    snapshot.outcomes[outcome]++;
    if (outcome === "minted" && receipt) addToBlock(receipt.blockHeight);
  }

  function addToBlock(height: bigint) {
    const key = height.toString();
    const block = snapshot.blocks.find((b) => b.height === key);
    if (block) block.minted++;
    else {
      snapshot.blocks.push({ height: key, minted: 1 });
      snapshot.blocks.sort((a, b) =>
        BigInt(a.height) < BigInt(b.height) ? -1 : 1,
      );
    }
  }

  async function observe(entry: Entry) {
    const status = await client.getTransactionStatus({
      transactionHash: entry.hash,
    });
    if (!("status" in status)) return;
    const failure =
      status.status === "recentFailure"
        ? status.cause
        : "recentFailure" in status
          ? status.recentFailure?.cause
          : undefined;
    if (status.status === "committed") {
      const receipt = await client.getTransactionReceipt({
        transactionHash: entry.hash,
      });
      if (receipt) settle(entry, classify(receipt), receipt);
    } else if (status.status === "dropped") {
      settle(entry, "notIncluded");
    } else if (
      status.status === "retry" &&
      Date.now() - entry.resubmittedAt >= RESUBMIT_MS
    ) {
      // Excluded from its block. `recentFailure` is advisory and not always
      // present; it only feeds the exclusion counts.
      if (failure && "kind" in failure && failure.kind === "dbConflict") {
        const code = failure.conflict.code;
        if (code === "boundsExceeded") snapshot.exclusions.supply++;
        else if (code === "insufficientFunds") snapshot.exclusions.funding++;
        else snapshot.exclusions.other++;
      }
      // Resubmit the same signed bytes, as a wallet does after `retry`.
      entry.resubmittedAt = Date.now();
      snapshot.resubmitted++;
      await client
        .sendTransaction({ signedTransaction: entry.bytes })
        .catch(() => undefined);
    }
  }
}

function classify(receipt: TransactionReceipt): keyof Outcomes {
  const execution = receipt.execution;
  if (!("result" in execution)) return "failed";
  if (execution.result === "return") return "minted";
  if (execution.result !== "abort") return "failed";
  try {
    const exception = NftDrop.v0_1.mint.decodeException(execution.abortData);
    // `mint` declares two error types, so match the name as well as the value.
    return exception.kind === "declared" &&
      exception.name === "DropError" &&
      exception.value === SOLD_OUT
      ? "soldOut"
      : "failed";
  } catch {
    return "failed";
  }
}

/** A request the service refuses; `status` is the HTTP status to return. */
export class RushError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const MAX_WINDOW_SECONDS = 60;

/**
 * Runs one rush at a time. Each crowd account has funds for one mint in
 * flight, so a second concurrent rush would have its mints dropped.
 */
export function createRushService(config: ServerConfig) {
  let current: RushSnapshot | null = null;
  let running = false;
  let nextId = 1;
  const listed = new Set<string>();
  let connecting: Promise<ConnectedThruputClient> | undefined;

  // One client for the rush. Its transport groups concurrent calls into
  // JSON-RPC arrays, so 10,000 submissions need only 40 HTTP requests.
  const client = () =>
    (connecting ??= createThruputClient({
      cluster: defineCluster({
        name: "local",
        rpcUrl: config.rpcUrl,
        networkHash: networkHash(hashFromBase58(config.app.networkId)),
        capabilities: [] as const,
      }),
      transport: new HttpTransport(config.rpcUrl, {
        timeoutMs: 30_000,
        batch: { maxSize: 250 },
      }),
    }).catch((error: unknown) => {
      connecting = undefined;
      throw error;
    }));

  /** The server signs mints only for drops in the configured factory's list. */
  async function isListed(rpc: CoreThruputClient, drop: string) {
    if (listed.has(drop)) return true;
    for (const address of await dropAddresses(rpc, config.app.factory))
      listed.add(toBase58(address));
    return listed.has(drop);
  }

  return {
    snapshot: () => current,
    async start(body: unknown): Promise<RushSnapshot> {
      if (!config.crowdSeed || config.crowdSize === 0)
        throw new RushError(
          503,
          "No crowd is configured. Run setup:local, then restart the app.",
        );
      const input =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      const { drop, users, windowSeconds } = input;
      if (
        typeof drop !== "string" ||
        !Number.isInteger(users) ||
        (users as number) < 1 ||
        (users as number) > config.crowdSize ||
        typeof windowSeconds !== "number" ||
        !(windowSeconds >= 0 && windowSeconds <= MAX_WINDOW_SECONDS)
      )
        throw new RushError(
          400,
          `Send a drop address, 1–${config.crowdSize} users, and a window of 0–${MAX_WINDOW_SECONDS} seconds.`,
        );
      let address: ContractAddress;
      try {
        address = addressFromBase58(drop);
      } catch {
        throw new RushError(400, "The drop address is not valid base58.");
      }
      if (running)
        throw new RushError(
          409,
          "A rush is already running. Wait for it to finish.",
        );
      running = true;
      try {
        const rpc = await client();
        if (!(await isListed(rpc, drop)))
          throw new RushError(400, "That drop is not in this app's factory.");
        const options = {
          client: rpc,
          seed: config.crowdSeed,
          drop: address,
          users: users as number,
          windowSeconds,
          id: nextId++,
        };
        const snapshot = emptySnapshot(options);
        current = snapshot;
        void runRush(options, snapshot).finally(() => {
          running = false;
        });
        return snapshot;
      } catch (error) {
        running = false;
        throw error;
      }
    },
  };
}
