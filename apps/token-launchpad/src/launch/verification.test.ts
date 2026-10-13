import { fixedBytes } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ERC20, ERC20Metadata } from "@/contracts/generated/standard-token";
import { createWorkflow } from "@/launch/workflow";
import { configuration } from "@/test/fixtures";
import {
  assessTokenState,
  readAndAssessTokenState,
  validateCreationEvidence,
} from "@/launch/verification";
import type { FactoryReview } from "@/contracts/launchpad-client";

afterEach(() => vi.restoreAllMocks());

function workflow() {
  const config = configuration();
  const review: FactoryReview = {
    config: {
      token_code_hash: fixedBytes(new Uint8Array(32), 32),
      required_token_funding: 100n,
      native_token: config.nativeHogAddress,
      creation_fee: 0n,
      fee_recipient: null,
    },
    predictedAddress: config.factoryAddress,
    predictedAddressHex: `0x${"03".repeat(32)}`,
    currentReserve: 0n,
    reserveHeight: 0n,
    fundingAmount: 110n,
    creatorBalance: 1_000n,
    fundingShortfall: 0n,
  };
  return createWorkflow(
    config,
    { name: "Acorn", symbol: "NUT", decimals: 7, initialSupply: 12n },
    new Uint8Array(32).fill(5),
    review,
  );
}

describe("readAndAssessTokenState", () => {
  it("retries temporary view failures before reporting success", async () => {
    vi.spyOn(ERC20Metadata.v0_1.name, "view")
      .mockRejectedValueOnce(new Error("not indexed"))
      .mockRejectedValueOnce(new Error("not indexed"))
      .mockResolvedValue({ value: "Acorn" } as never);
    vi.spyOn(ERC20Metadata.v0_1.symbol, "view").mockResolvedValue({
      value: "NUT",
    } as never);
    vi.spyOn(ERC20Metadata.v0_1.decimals, "view").mockResolvedValue({
      value: 7n,
    } as never);
    vi.spyOn(ERC20.v0_1.totalSupply, "view").mockResolvedValue({
      value: 12n,
    } as never);
    vi.spyOn(ERC20.v0_1.getBalanceOf, "view").mockResolvedValue({
      value: 12n,
    } as never);
    const retryWait = vi.fn().mockResolvedValue(undefined);
    const config = configuration();
    await expect(
      readAndAssessTokenState({
        client: {} as never,
        token: config.factoryAddress,
        caller: config.accountAddress,
        workflow: workflow(),
        retryWait,
      }),
    ).resolves.toMatchObject({ status: "complete" });
    expect(ERC20Metadata.v0_1.name.view).toHaveBeenCalledTimes(3);
    expect(retryWait).toHaveBeenCalledTimes(2);
  });
});

describe("assessTokenState", () => {
  it("accepts matching metadata, supply, and holder balance", () => {
    expect(
      assessTokenState(workflow(), {
        name: "Acorn",
        symbol: "NUT",
        decimals: 7n,
        totalSupply: 12n,
        holderBalance: 12n,
      }),
    ).toEqual({
      status: "complete",
      message: null,
      totalSupply: "12",
      holderBalance: "12",
    });
  });

  it("preserves observations when mutable state has changed", () => {
    expect(
      assessTokenState(workflow(), {
        name: "Acorn",
        symbol: "NUT",
        decimals: 7n,
        totalSupply: 13n,
        holderBalance: 12n,
      }),
    ).toMatchObject({
      status: "incomplete",
      totalSupply: "13",
      holderBalance: "12",
    });
  });
});

describe("validateCreationEvidence", () => {
  const zero = contractAddress(new Uint8Array(32));
  const creator = contractAddress(new Uint8Array(32).fill(2));
  const token = contractAddress(new Uint8Array(32).fill(3));

  it("accepts matching creation and canonical mint evidence", () => {
    expect(() =>
      validateCreationEvidence({
        created: token,
        predicted: token,
        creator,
        expectedTokenHash: new Uint8Array(32),
        workflow: workflow(),
        createdEvent: createdEvent(),
        mintEvents: [mintEvent()],
      }),
    ).not.toThrow();
  });

  it("rejects address, event, noncanonical mint, and duplicate evidence", () => {
    const input = {
      created: token,
      predicted: token,
      creator,
      expectedTokenHash: new Uint8Array(32),
      workflow: workflow(),
      createdEvent: createdEvent(),
      mintEvents: [mintEvent()],
    };
    expect(() =>
      validateCreationEvidence({
        ...input,
        predicted: contractAddress(new Uint8Array(32).fill(9)),
      }),
    ).toThrow(/differs from the prediction/);
    expect(() =>
      validateCreationEvidence({
        ...input,
        createdEvent: {
          ...createdEvent(),
          fields: { ...createdEvent().fields, symbol: "BAD" },
        },
      }),
    ).toThrow(/TokenCreated/);
    expect(() =>
      validateCreationEvidence({
        ...input,
        mintEvents: [
          {
            ...mintEvent(),
            topics: { to: zero },
          },
        ],
      }),
    ).toThrow(/mint event/);
    expect(() =>
      validateCreationEvidence({
        ...input,
        mintEvents: [mintEvent(), mintEvent()],
      }),
    ).toThrow(/mint event/);
  });

  it("requires no mint event for a zero initial supply", () => {
    const zeroWorkflow = {
      ...workflow(),
      token: { ...workflow().token, initialSupply: "0" },
    };
    const event = createdEvent();
    event.fields.initial_supply = 0n;
    expect(() =>
      validateCreationEvidence({
        created: token,
        predicted: token,
        creator,
        expectedTokenHash: new Uint8Array(32),
        workflow: zeroWorkflow,
        createdEvent: event,
        mintEvents: [],
      }),
    ).not.toThrow();
    expect(() =>
      validateCreationEvidence({
        created: token,
        predicted: token,
        creator,
        expectedTokenHash: new Uint8Array(32),
        workflow: zeroWorkflow,
        createdEvent: event,
        mintEvents: [mintEvent()],
      }),
    ).toThrow(/mint event/);
  });

  function createdEvent() {
    return {
      name: "TokenCreated" as const,
      topics: { token, creator },
      fields: {
        administrator: creator,
        initial_holder: creator,
        initial_supply: 12n,
        name: "Acorn",
        symbol: "NUT",
        decimals: 7n,
        token_code_hash: fixedBytes(new Uint8Array(32), 32),
      },
    };
  }

  function mintEvent() {
    return {
      name: "MintEvent" as const,
      topics: { to: creator },
      fields: { amount: 12n },
    };
  }
});
