import {
  fromHex0x,
  PrivateKeySigner,
  toHex0x,
  type GroundhogClient,
} from "@groundhogchain/client";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "@/config";
import { parseDevelopmentPersonas } from "@/development-personas";
import { observeCompletions } from "@/transactions/observer";
import {
  requestStorageKey,
  saveRequests,
  transactionScope,
  type TickRequestRecord,
} from "@/transactions/records";
import { TransactionActivity } from "./transaction-activity";

vi.mock("@/transactions/observer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transactions/observer")>()),
  observeCompletions: vi.fn(),
}));

const config = {
  networkId: "11".repeat(32),
  contractAddress: `0x${"22".repeat(32)}`,
  transactionProfiles: {
    request: {
      transactionGasLimit: 100_000n,
      targetGasLimit: 100_000n,
      expiryBlocks: 64n,
      observationTimeoutMs: 30_000,
    },
    crank: {
      transactionGasLimit: 10_010_000_000n,
      targetGasLimit: 10_000_000_000n,
      expiryBlocks: 2n,
      observationTimeoutMs: 300_000,
    },
  },
} as Readonly<AppConfig>;

describe("transaction activity", () => {
  test("preserves the read surface and reports malformed durable storage", () => {
    const persona = parseDevelopmentPersonas(JSON.stringify(personas()))![0]!;
    const scope = transactionScope(config, persona.expectedCallerHex);
    localStorage.setItem(requestStorageKey(scope), "malformed");
    render(
      <TransactionActivity
        config={config}
        profiles={config.transactionProfiles!}
        persona={persona}
        client={{} as GroundhogClient}
        onCrankCommitted={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid/);
    expect(
      screen.getByRole("button", { name: "Advance 100,000,000 cells" }),
    ).toBeEnabled();
    expect(localStorage.getItem(requestStorageKey(scope))).toBe("malformed");
  });

  test("clears an observer error after a successful no-op scan", async () => {
    const persona = parseDevelopmentPersonas(JSON.stringify(personas()))![0]!;
    const scope = transactionScope(config, persona.expectedCallerHex);
    saveRequests(scope, [acceptedRequest(persona.expectedCallerHex)]);
    vi.mocked(observeCompletions)
      .mockRejectedValueOnce(new Error("observer unavailable"))
      .mockResolvedValueOnce({
        observations: [],
        observedThroughBlock: null,
        retentionGapRequestIds: new Set(),
      });
    let rescan: (() => Promise<void>) | null = null;
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      rescan ??= handler as () => Promise<void>;
      return {} as ReturnType<typeof setInterval>;
    });

    render(
      <TransactionActivity
        config={config}
        profiles={config.transactionProfiles!}
        persona={persona}
        client={{} as GroundhogClient}
        onCrankCommitted={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "observer unavailable",
    );

    await act(() => Promise.resolve());
    await act(async () => {
      await rescan!();
    });
    expect(observeCompletions).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("does not clear a newer storage error when an older scan succeeds", async () => {
    const persona = parseDevelopmentPersonas(JSON.stringify(personas()))![0]!;
    const scope = transactionScope(config, persona.expectedCallerHex);
    saveRequests(scope, [acceptedRequest(persona.expectedCallerHex)]);
    let resolveObservation!: (
      value: Awaited<ReturnType<typeof observeCompletions>>,
    ) => void;
    vi.mocked(observeCompletions).mockImplementation(
      () => new Promise((resolve) => (resolveObservation = resolve)),
    );

    render(
      <TransactionActivity
        config={config}
        profiles={config.transactionProfiles!}
        persona={persona}
        client={{} as GroundhogClient}
        onCrankCommitted={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(observeCompletions).toHaveBeenCalledOnce());

    act(() => {
      localStorage.setItem(requestStorageKey(scope), "malformed");
      window.dispatchEvent(
        new StorageEvent("storage", { key: requestStorageKey(scope) }),
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid/);

    await act(async () => {
      resolveObservation({
        observations: [],
        observedThroughBlock: null,
        retentionGapRequestIds: new Set(),
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid/);
  });
});

afterEach(() => {
  vi.mocked(observeCompletions).mockReset();
  vi.restoreAllMocks();
});

function personas() {
  return (["alice", "bob", "carol"] as const).map((id, index) => {
    const privateKey = `0x${(index + 1).toString(16).padStart(64, "0")}`;
    const signer = new PrivateKeySigner(fromHex0x(privateKey));
    const walletRoot = `0x${(index + 10).toString(16).padStart(64, "0")}`;
    return {
      id,
      label: id,
      privateKey,
      signerPublicKey: toHex0x(signer.publicKey.ed25519),
      walletRoot,
      walletEntrypoint: "0x19846d750fad81d6",
      expectedCaller: walletRoot,
      callerVerified: true,
    };
  });
}

function acceptedRequest(requester: string): TickRequestRecord {
  return {
    schemaVersion: 1,
    localId: "request-1",
    requester,
    status: "accepted",
    transactionHash: `0x${"44".repeat(32)}`,
    requestId: `0x${"55".repeat(32)}`,
    receiptBlock: "7",
    submittedAt: "2026-08-29T00:00:00.000Z",
    acceptedAt: "2026-08-29T00:00:01.000Z",
    observedThroughBlock: null,
    resultingGeneration: null,
    resultingPopulation: null,
    resultingStateDigest: null,
    advancedTransactionHash: null,
    diagnostic: null,
  };
}
