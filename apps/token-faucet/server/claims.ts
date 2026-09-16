import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { addressFromHex, toHex0x } from "@groundhogchain/client";
import { ERC20 } from "@groundhogchain/client/contracts";
import { codec, gasAmount, serialize } from "@groundhogchain/protocol";
import {
  executeStep,
  saveJson,
  type SeedJournal,
} from "../../../scripts/seed/seed-journal.ts";
import {
  canonicalAddress,
  type ClaimStatus,
  type FaucetToken,
} from "../src/domain.ts";
import type { connectChain } from "./chain.ts";

interface ClaimRecord extends SeedJournal {
  receipt?: string;
}

export class ClaimService {
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  constructor(
    private readonly directory: string,
    private readonly tokens: readonly FaucetToken[],
    private readonly chain: Awaited<ReturnType<typeof connectChain>>,
  ) {}

  private path(token: string, recipient: string): string {
    if (!this.tokens.some((entry) => entry.address === token))
      throw new Error("Unknown faucet token.");
    return join(this.directory, `${token}-${recipient}.json`);
  }

  private async read(path: string): Promise<ClaimRecord> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as ClaimRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { steps: {} };
      throw error;
    }
  }

  async status(token: string, recipient: string): Promise<ClaimStatus> {
    const record = await this.read(
      this.path(canonicalAddress(token), canonicalAddress(recipient)),
    );
    if (record.receipt)
      return { state: "claimed", transactionHash: record.receipt };
    const attempt = record.steps.claim?.at(-1);
    return attempt
      ? { state: "pending", transactionHash: attempt.hash }
      : { state: "available" };
  }

  async claim(
    tokenInput: string,
    recipientInput: string,
  ): Promise<ClaimStatus> {
    const token = canonicalAddress(tokenInput);
    const recipient = canonicalAddress(recipientInput);
    const path = this.path(token, recipient);
    if (this.waiting >= 20)
      throw new Error("The faucet is busy. Please retry shortly.");
    this.waiting++;
    const result = this.queue.then(async () => {
      const record = await this.read(path);
      if (record.receipt)
        return { state: "claimed" as const, transactionHash: record.receipt };
      await this.chain.verifyNetwork();
      const details = this.tokens.find((entry) => entry.address === token)!;
      const gas = gasAmount(1_000_000n);
      const invocation = ERC20.transfer.invocation(addressFromHex(token), gas, {
        receiver: addressFromHex(recipient),
        amount: 10n * 10n ** BigInt(details.decimals),
      });
      const receipt = await executeStep({
        name: "claim",
        intent: toHex0x(serialize(invocation, codec.Invocation)),
        journal: record,
        save: () => saveJson(path, record),
        client: this.chain.client,
        retryFailed: true,
        prepare: async () =>
          this.chain.wallet.signTransaction(
            await this.chain.wallet.prepareExecution({
              invocation,
              gasLimit: gas,
              expiryBlocks: 1_000n,
            }),
          ),
      });
      record.receipt = toHex0x(receipt.txHash);
      await saveJson(path, record);
      return { state: "claimed" as const, transactionHash: record.receipt };
    });
    this.queue = result.catch(() => {});
    try {
      return await result;
    } finally {
      this.waiting--;
    }
  }

  async drain(): Promise<void> {
    await this.queue;
  }
}
