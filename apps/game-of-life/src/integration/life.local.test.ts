// @vitest-environment node
import {
  addressFromHex,
  createGroundhogClient,
  HttpTransport,
  toHex0x,
} from "@groundhogchain/client";
import { gasAmount } from "@groundhogchain/protocol";
import { describe, expect, test } from "vitest";
import { loadAppConfig } from "@/config";
import {
  GameOfLife,
  GenerationAdvanced,
  TickRequested,
} from "@/contracts/generated/game-of-life";
import { parseDevelopmentPersonas } from "@/development-personas";
import { createLocalWriteBoundary } from "@/transactions/write-boundary";

const enabled = process.env.RUN_GAME_OF_LIFE_LOCAL_INTEGRATION === "1";

describe.skipIf(!enabled)("local Alice, Bob, and Carol lifecycle", () => {
  test("correlates admission, another persona's crank, and an empty no-op", async () => {
    const config = loadAppConfig(import.meta.env);
    const profiles = config.transactionProfiles;
    const personas = parseDevelopmentPersonas(
      import.meta.env.GROUNDHOG_DEV_PERSONAS,
    );
    if (!profiles || !personas)
      throw new Error("Local integration configuration is incomplete");
    const client = await createGroundhogClient({
      transport: new HttpTransport(config.rpcUrl.href),
    });
    const contract = addressFromHex(config.contractAddress);
    const pending = new Set<string>();
    for (const persona of personas) {
      const boundary = createLocalWriteBoundary(config, persona, client);
      const target = GameOfLife.requestTick.invocation(
        contract,
        gasAmount(profiles.request.targetGasLimit),
      );
      const result = await boundary.execute(target, profiles.request, {
        onSigned(hash) {
          console.info(`${persona.label} request signed: ${hash}`);
        },
      });
      console.info(`${persona.label} request outcome: ${result.kind}`);
      expect(result.kind).toBe("committedSuccess");
      if (result.kind !== "committedSuccess") continue;
      const events = TickRequested.allFromReceipt(result.receipt, {
        contractAddress: contract,
      });
      expect(events).toHaveLength(1);
      expect(toHex0x(events[0]!.topics.requested_by)).toBe(
        persona.expectedCallerHex,
      );
      pending.add(toHex0x(events[0]!.topics.request_id));
    }

    const crankPersona = personas[1]!;
    const boundary = createLocalWriteBoundary(config, crankPersona, client);
    for (let attempt = 0; pending.size > 0 && attempt < 64; attempt += 1) {
      console.info(
        `Bob crank ${attempt + 1}; tracked requests remaining: ${pending.size}`,
      );
      const result = await boundary.execute(
        GameOfLife.processNextTick.invocation(
          contract,
          gasAmount(profiles.crank.targetGasLimit),
        ),
        profiles.crank,
        {
          onSigned(hash) {
            console.info(`Bob crank ${attempt + 1} signed: ${hash}`);
          },
        },
      );
      console.info(`Bob crank ${attempt + 1} outcome: ${result.kind}`);
      expect(result.kind).toBe("committedSuccess");
      if (result.kind !== "committedSuccess") continue;
      const events = GenerationAdvanced.allFromReceipt(result.receipt, {
        contractAddress: contract,
      });
      expect(events.length).toBeLessThanOrEqual(1);
      if (events[0]) pending.delete(toHex0x(events[0].topics.request_id));
    }
    expect(pending).toEqual(new Set());

    const empty = await boundary.execute(
      GameOfLife.processNextTick.invocation(
        contract,
        gasAmount(profiles.crank.targetGasLimit),
      ),
      profiles.crank,
      { onSigned() {} },
    );
    expect(empty.kind).toBe("committedSuccess");
    if (empty.kind === "committedSuccess") {
      expect(
        GenerationAdvanced.allFromReceipt(empty.receipt, {
          contractAddress: contract,
        }),
      ).toEqual([]);
      expect(empty.receipt.returnData).not.toBeNull();
      expect(
        GameOfLife.processNextTick.decodeReturn(empty.receipt.returnData!),
      ).toBeNull();
    }
  }, 420_000);
});
