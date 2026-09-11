import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultWalletAdapter,
  prepareTransaction,
  serializeTransaction,
  toHex0x,
  hashSignedTransaction,
  createProviderWalletClient,
  createGroundhogClient,
  MockTransport,
} from "@groundhogchain/client";
import { ERC20 } from "@groundhogchain/client/contracts";
import {
  blockHeight,
  contractAddress,
  gasAmount,
} from "@groundhogchain/protocol";
import {
  accountOf,
  deriveKey,
  encryptVault,
  newVault,
  publicAccount,
} from "./vault";
import type {
  WalletProvider,
  WalletSession,
  ProviderRequest,
  SignTransactionResult,
} from "@groundhogchain/client/provider";
import { PENDING_TRANSFER_ADVISORY, type OutgoingTransfer } from "./lifecycle";

const mock = vi.hoisted(() => ({
  send: vi.fn(),
  airdrop: vi.fn(),
  hash: new Uint8Array(32),
  change: vi.fn(),
  write: vi.fn(),
  receipt: vi.fn(),
  waitReceipt: vi.fn(),
  networkInfo: vi.fn(),
  frame: vi.fn(),
  encrypt: vi.fn(),
}));
vi.mock("./vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vault")>();
  return {
    ...actual,
    encryptVault: async (...args: Parameters<typeof actual.encryptVault>) => {
      await mock.encrypt();
      return actual.encryptVault(...args);
    },
  };
});
vi.mock("./network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./network")>()),
  clientFor: async () => ({
    getNetworkInfo: mock.networkInfo,
    sendTransaction: mock.send,
    requestAirdrop: mock.airdrop,
    getTransactionReceipt: mock.receipt,
    waitForTransactionReceipt: mock.waitReceipt,
  }),
}));
let saved: Record<string, unknown>;
let messageListener: (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (reply: Reply) => void,
) => void;
let removed: (id: number) => void;
let tabRemoved: (id: number) => void;
let navigated: (details: object) => void;
let alarm: (alarm: { name: string }) => void;
let windows: { url: string }[];
interface Reply {
  result?: unknown;
  error?: { code: number; message: string };
}
const pass = "a strong testing password";
const secretVault = newVault(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const secret = secretVault.accounts[0]!,
  account = publicAccount(secret).address;
const extension = {
  id: "extension",
  url: "chrome-extension://extension/index.html",
};
const page = {
  id: "extension",
  frameId: 0,
  tab: { id: 10 },
  documentId: "doc1",
  url: "https://app.example/",
  origin: "https://app.example",
} as chrome.runtime.MessageSender;
function message(
  value: object,
  sender: chrome.runtime.MessageSender = extension,
): Promise<Reply> {
  return new Promise((resolve) => messageListener(value, sender, resolve));
}
async function ui(
  op: string,
  data: object = {},
  sender: chrome.runtime.MessageSender = extension,
) {
  return message({ kind: "ui", op, ...data }, sender);
}
async function boot() {
  vi.resetModules();
  await import("./worker");
  await ui("state");
}
async function approve(
  method: "connect" | "signTransaction",
  transaction?: string,
) {
  const response = message(
    {
      kind: "provider",
      id: crypto.randomUUID(),
      request:
        method === "connect"
          ? { method }
          : {
              method,
              params: { account, networkHash: "00".repeat(32), transaction },
            },
    },
    page,
  );
  await decideNext();
  return response;
}
async function decideNext() {
  await vi.waitFor(() => expect(windows.length).toBeGreaterThan(0));
  const url = windows.pop()!.url,
    id = new URL(url).searchParams.get("approval");
  const decision = await ui(
    "decide",
    { id, approve: true, accounts: [account] },
    { ...extension, url, tab: { id: 20 } } as chrome.runtime.MessageSender,
  );
  expect(decision.error).toBeUndefined();
}
async function transaction() {
  const wallet = accountOf(secret);
  return prepareTransaction(
    { getChainTip: async () => ({ height: blockHeight(1n) }) as never },
    wallet,
    {
      invocation: defaultWalletAdapter.createRootInvocation(wallet.address, {
        gasLimit: gasAmount(100000n),
        invocation: ERC20.transfer.invocation(
          contractAddress(new Uint8Array(32).fill(1)),
          gasAmount(50000n),
          { receiver: wallet.address, amount: 1n },
        ),
      }),
    },
  );
}
const request = (value: ProviderRequest, sender = page) =>
  message(
    { kind: "provider", id: crypto.randomUUID(), request: value },
    sender,
  );
const submit = (signed: SignTransactionResult) =>
  request({
    method: "submitTransaction",
    params: {
      account,
      networkHash: "00".repeat(32),
      signedTransaction: signed.signedTransaction,
    },
  });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
beforeEach(async () => {
  windows = [];
  saved = {};
  mock.hash = new Uint8Array(32);
  mock.send
    .mockReset()
    .mockImplementation(async (stx) => hashSignedTransaction(stx));
  mock.airdrop.mockReset();
  mock.change.mockReset();
  mock.write.mockReset();
  mock.receipt.mockReset().mockResolvedValue(null);
  mock.waitReceipt.mockReset().mockRejectedValue(new Error("Receipt timeout"));
  mock.networkInfo
    .mockReset()
    .mockImplementation(async () => ({ networkHash: mock.hash }));
  mock.frame
    .mockReset()
    .mockResolvedValue({ documentId: "doc1", url: page.url });
  mock.encrypt.mockReset();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension",
      getURL: (path: string) =>
        `chrome-extension://extension/${path.replace(/^\//, "")}`,
      onMessage: {
        addListener: (listener: typeof messageListener) => {
          messageListener = listener;
        },
      },
      sendMessage: async () => {},
    },
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async () => structuredClone(saved),
        set: async (value: object) => {
          await mock.write(value);
          saved = structuredClone({ ...saved, ...value });
        },
      },
      session: { setAccessLevel: async () => {} },
    },
    alarms: {
      create: async () => {},
      onAlarm: {
        addListener: (listener: typeof alarm) => {
          alarm = listener;
        },
      },
    },
    windows: {
      create: async (options: { url: string }) => {
        windows.push(options);
        return { id: 30, tabs: [{ id: 20 }] };
      },
      remove: async () => {},
      onRemoved: {
        addListener: (listener: typeof removed) => {
          removed = listener;
        },
      },
    },
    tabs: {
      query: async () => [],
      sendMessage: async (...args: unknown[]) => {
        await mock.change(...args);
      },
      onRemoved: {
        addListener: (listener: typeof tabRemoved) => {
          tabRemoved = listener;
        },
      },
    },
    webNavigation: {
      getFrame: mock.frame,
      onCommitted: {
        addListener: (listener: typeof navigated) => {
          navigated = listener;
        },
      },
    },
  });
  saved.wallet = {
    envelope: await encryptVault(secretVault, pass),
    network: "localnet",
    pin: "00".repeat(32),
    grants: {},
    approvals: [],
    tokens: {},
    airdrops: {},
  };
  await boot();
  expect((await ui("unlock", { password: pass })).error).toBeUndefined();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("worker lifecycle and authorization", () => {
  it.each(["preflight", "approval"])(
    "expires %s at 115 seconds, clears its timer, and frees its origin slot",
    async (stage) => {
      const gate = deferred();
      if (stage === "preflight") {
        mock.networkInfo.mockImplementationOnce(async () => {
          await gate.promise;
          return { networkHash: mock.hash };
        });
      }
      const remove = vi.spyOn(chrome.windows, "remove");
      const settled = vi.fn();
      vi.useFakeTimers();
      try {
        const connecting = request({ method: "connect" }).then((reply) => {
          settled();
          return reply;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(windows).toHaveLength(stage === "preflight" ? 0 : 1);
        const id =
          windows[0] && new URL(windows[0].url).searchParams.get("approval");
        await vi.advanceTimersByTimeAsync(114999);
        expect(settled).not.toHaveBeenCalled();
        expect((await request({ method: "connect" })).error?.code).toBe(-32002);
        await vi.advanceTimersByTimeAsync(1);
        expect((await connecting).error).toEqual({
          code: 4001,
          message: "Approval timed out",
        });
        expect(settled).toHaveBeenCalledTimes(1);
        if (stage === "approval") {
          expect(remove).toHaveBeenCalledExactlyOnceWith(30);
          expect((await ui("approval", { id })).error?.code).toBe(4001);
          windows.pop();
        } else {
          gate.release();
          await vi.advanceTimersByTimeAsync(0);
          expect(windows).toHaveLength(0);
          expect(remove).not.toHaveBeenCalled();
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        gate.release();
        vi.useRealTimers();
      }
      expect((await approve("connect")).error).toBeUndefined();
    },
  );
  it("cancels while window creation is unresolved and closes the late window without reviving approval", async () => {
    const gate = deferred();
    const create = vi
      .spyOn(chrome.windows, "create")
      .mockImplementationOnce(async () => {
        await gate.promise;
        return { id: 31, tabs: [{ id: 21 }] } as chrome.windows.Window;
      });
    const remove = vi.spyOn(chrome.windows, "remove");
    const id = crypto.randomUUID();
    const connecting = message(
      { kind: "provider", id, request: { method: "connect" } },
      page,
    );
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const approvalId = new URL(
      create.mock.calls[0]![0]!.url as string,
    ).searchParams.get("approval");
    await message({ kind: "cancel", id }, page);
    expect((await connecting).error?.code).toBe(4001);
    expect(remove).not.toHaveBeenCalled();
    gate.release();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(31));
    expect((await ui("approval", { id: approvalId })).error?.code).toBe(4001);
    expect((await request({ method: "getSession" })).result).toMatchObject({
      accounts: [],
    });
    expect((await approve("connect")).error).toBeUndefined();
  });
  it.each(["persistence", "delivery"])(
    "canceled connect during %s remains revoked when cleanup fails, including lock/unlock and restart",
    async (stage) => {
      const connecting = request({ method: "connect" });
      await vi.waitFor(() => expect(windows).toHaveLength(1));
      const url = windows.pop()!.url;
      const id = new URL(url).searchParams.get("approval");
      const gate = deferred();
      if (stage === "persistence")
        mock.write.mockImplementationOnce(() => gate.promise);
      else mock.change.mockImplementationOnce(() => gate.promise);
      const deciding = ui(
        "decide",
        { id, approve: true, accounts: [account] },
        {
          ...extension,
          url,
          tab: { id: 20 },
        } as chrome.runtime.MessageSender,
      );
      if (stage === "persistence") {
        await vi.waitFor(() => expect(mock.write).toHaveBeenCalled());
        // Wait for this decision's write, rather than the startup/unlock writes.
        await vi.waitFor(() =>
          expect(
            mock.write.mock.results.some((r) => r.value === gate.promise),
          ).toBe(true),
        );
      } else await vi.waitFor(() => expect(mock.change).toHaveBeenCalled());
      removed(30);
      expect((await connecting).error?.code).toBe(4001);
      expect((await request({ method: "getSession" })).result).toMatchObject({
        accounts: [],
      });
      const retrying = request({ method: "connect" });
      await vi.waitFor(() => expect(windows).toHaveLength(1));
      const retryId = new URL(windows.pop()!.url).searchParams.get("approval");
      mock.write.mockRejectedValueOnce(new Error("Cleanup write failed"));
      gate.release();
      expect((await deciding).error?.message).toBe("Cleanup write failed");
      // Cleanup of the canceled request must not invalidate a newer preflight.
      expect((await ui("approval", { id: retryId })).error).toBeUndefined();
      removed(30);
      expect((await retrying).error?.code).toBe(4001);
      expect((saved.wallet as { grants?: unknown }).grants).toBeUndefined();
      expect((await request({ method: "getSession" })).result).toMatchObject({
        accounts: [],
      });
      await ui("lock");
      await ui("unlock", { password: pass });
      expect((await request({ method: "getSession" })).result).toMatchObject({
        accounts: [],
      });
      await boot();
      await ui("unlock", { password: pass });
      expect((await request({ method: "getSession" })).result).toMatchObject({
        accounts: [],
      });
    },
  );
  it("keeps approved grants through lock/unlock but never restores grants after restart or from legacy storage", async () => {
    await approve("connect");
    await ui("lock");
    await ui("unlock", { password: pass });
    expect((await request({ method: "getSession" })).result).toMatchObject({
      accounts: [publicAccount(secret)],
    });
    // Old versions persisted grants; they have no authority in the new worker.
    (saved.wallet as { grants: object }).grants = {
      [page.origin!]: { networkHash: "00".repeat(32), accounts: [account] },
    };
    await boot();
    await ui("unlock", { password: pass });
    expect((await request({ method: "getSession" })).result).toMatchObject({
      accounts: [],
    });
    expect((saved.wallet as { grants?: unknown }).grants).toBeUndefined();
    expect((await approve("connect")).error).toBeUndefined();
  });
  it("cancels a document-bound preflight before popup creation and releases the slot", async () => {
    const gate = deferred();
    mock.networkInfo.mockClear().mockImplementationOnce(async () => {
      await gate.promise;
      return { networkHash: mock.hash };
    });
    const id = crypto.randomUUID();
    const connecting = message(
      { kind: "provider", id, request: { method: "connect" } },
      page,
    );
    await vi.waitFor(() => expect(mock.networkInfo).toHaveBeenCalledTimes(1));
    await message(
      { kind: "cancel", id },
      { ...page, documentId: "other-document" },
    );
    expect((await request({ method: "connect" })).error?.code).toBe(-32002);
    await message({ kind: "cancel", id }, page);
    expect((await connecting).error?.code).toBe(4001);
    gate.release();
    await vi.waitFor(() =>
      expect(mock.networkInfo.mock.settledResults[0]?.type).toBe("fulfilled"),
    );
    expect(windows).toHaveLength(0);
    expect((await approve("connect")).error).toBeUndefined();
  });
  it("fails closed when legacy grant cleanup fails and requires approval after recovery", async () => {
    (saved.wallet as { grants: object }).grants = {
      [page.origin!]: { networkHash: "00".repeat(32), accounts: [account] },
    };
    mock.write.mockRejectedValueOnce(new Error("Startup cleanup failed"));
    await boot();
    expect((await ui("unlock", { password: pass })).error?.message).toBe(
      "Startup cleanup failed",
    );
    expect((await request({ method: "getSession" })).result).toBeUndefined();
    await boot();
    await ui("unlock", { password: pass });
    expect((await request({ method: "getSession" })).result).toMatchObject({
      accounts: [],
    });
    expect((await approve("connect")).error).toBeUndefined();
  });
  it("bounds preflights globally and frees every reserved slot on cancellation", async () => {
    const gate = deferred();
    mock.networkInfo.mockClear().mockImplementation(async () => {
      await gate.promise;
      return { networkHash: mock.hash };
    });
    const attempts = Array.from({ length: 8 }, (_, index) => {
      const sender = {
        ...page,
        origin: `https://site${index}.example`,
        url: `https://site${index}.example/`,
        documentId: `doc${index}`,
      };
      const id = crypto.randomUUID();
      return {
        id,
        sender,
        response: message(
          { kind: "provider", id, request: { method: "connect" } },
          sender,
        ),
      };
    });
    await vi.waitFor(() => expect(mock.networkInfo).toHaveBeenCalledTimes(8));
    expect((await request({ method: "connect" })).error?.code).toBe(-32002);
    for (const attempt of attempts) {
      await message({ kind: "cancel", id: attempt.id }, attempt.sender);
      expect((await attempt.response).error?.code).toBe(4001);
    }
    gate.release();
    expect((await approve("connect")).error).toBeUndefined();
  });
  it("delivers connect/disconnect changes before resolving and immediately prepares through the real SDK adapter", async () => {
    const listeners = new Set<(session: WalletSession) => void>();
    const events: string[] = [];
    const gate = deferred();
    mock.change.mockImplementation(async (_tab, message) => {
      await gate.promise;
      events.push("change");
      for (const listener of listeners) listener(message.session);
    });
    const provider: WalletProvider = {
      info: { id: "test", name: "Test", version: "1.0.0" },
      request: async (value) => {
        const reply = await request(value);
        if (reply.error)
          throw Object.assign(new Error(reply.error.message), {
            code: reply.error.code,
          });
        return reply.result;
      },
      on: (_event, listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const connecting = provider
      .request({ method: "connect" })
      .then((session) => {
        events.push("connect resolved");
        return session as WalletSession;
      });
    const deciding = decideNext();
    await vi.waitFor(() => expect(mock.change).toHaveBeenCalled());
    expect(events).toEqual([]);
    gate.release();
    const session = await connecting;
    await deciding;
    expect(events).toEqual(["change", "connect resolved"]);
    const adapter = createProviderWalletClient({
      provider,
      account: session.accounts[0]!,
      networkHash: session.networkHash,
      client: await createGroundhogClient({ transport: new MockTransport() }),
    });
    await expect(
      adapter.prepareExecution({
        gasLimit: gasAmount(100000n),
        invocation: ERC20.transfer.invocation(
          contractAddress(new Uint8Array(32).fill(1)),
          gasAmount(50000n),
          {
            receiver: accountOf(secret).address,
            amount: 1n,
          },
        ),
      }),
    ).resolves.toBeDefined();
    events.length = 0;
    const disconnectGate = deferred();
    mock.change.mockImplementationOnce(async () => {
      await disconnectGate.promise;
      events.push("change");
    });
    const disconnecting = provider
      .request({ method: "disconnect" })
      .then(() => events.push("disconnect resolved"));
    await vi.waitFor(() => expect(mock.change).toHaveBeenCalledTimes(2));
    expect(events).toEqual([]);
    disconnectGate.release();
    await disconnecting;
    expect(events).toEqual(["change", "disconnect resolved"]);
    adapter.dispose();
  });
  it("lock cancels both running and queued unlocks from two wallet windows", async () => {
    await ui("lock");
    const gate = deferred();
    mock.write.mockClear().mockImplementationOnce(() => gate.promise);
    const first = ui("unlock", { password: pass }, {
      ...extension,
      tab: { id: 20 },
    } as chrome.runtime.MessageSender);
    await vi.waitFor(() => expect(mock.write).toHaveBeenCalledTimes(1));
    const second = ui("unlock", { password: pass }, {
      ...extension,
      tab: { id: 21 },
    } as chrome.runtime.MessageSender);
    await ui("lock");
    gate.release();
    expect((await first).error?.code).toBe(4001);
    expect((await second).error?.code).toBe(4001);
    expect((await ui("state")).result).toMatchObject({
      unlocked: false,
      accounts: [],
    });
    expect(mock.write).toHaveBeenCalledTimes(1);
    expect((await ui("unlock", { password: pass })).error).toBeUndefined();
  });
  it.each(["generate", "restore"])(
    "lock cancels queued %s before it can create a vault",
    async (mode) => {
      saved = {};
      await boot();
      const gate = deferred();
      mock.encrypt.mockClear().mockImplementationOnce(async () => {
        await gate.promise;
        throw new Error("Encryption failed");
      });
      const creating = ui("create", { password: pass });
      await vi.waitFor(() => expect(mock.encrypt).toHaveBeenCalledTimes(1));
      const queued = ui("create", {
        password: pass,
        ...(mode === "restore" ? { mnemonic: secretVault.mnemonic } : {}),
      });
      await ui("lock");
      gate.release();
      expect((await creating).error).toBeDefined();
      expect((await queued).error?.code).toBe(4001);
      expect(mock.encrypt).toHaveBeenCalledTimes(1);
      expect((await ui("state")).result).toMatchObject({
        exists: false,
        unlocked: false,
      });
    },
  );
  it("ignores an old lock alarm while a locked connection awaits unlock", async () => {
    const oldExpiry = ((await ui("state")).result as { expires: number })
      .expires;
    await ui("lock");
    const connecting = request({ method: "connect" });
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    vi.spyOn(Date, "now").mockReturnValue(oldExpiry);
    alarm({ name: "lock" });
    expect((await ui("state")).result).toMatchObject({ unlocked: false });
    await ui("unlock", { password: pass });
    // A late delivery must not lock a newer, unexpired session either.
    alarm({ name: "lock" });
    expect((await ui("state")).result).toMatchObject({ unlocked: true });
    await decideNext();
    expect((await connecting).error).toBeUndefined();
  });
  it("an active session expiry alarm locks and cancels its pending connection", async () => {
    const expiry = ((await ui("state")).result as { expires: number }).expires;
    const connecting = request({ method: "connect" });
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    vi.spyOn(Date, "now").mockReturnValue(expiry);
    alarm({ name: "lock" });
    expect((await connecting).error?.code).toBe(4001);
    expect((await ui("state")).result).toMatchObject({
      unlocked: false,
      expires: 0,
    });
  });
  it("keeps a locked connect pending through a wrong password and unlock until account approval", async () => {
    await ui("addAccount");
    await ui("lock");
    const settled = vi.fn();
    const connecting = request({ method: "connect" }).then((reply) => {
      settled();
      return reply;
    });
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    const url = windows[0]!.url;
    const id = new URL(url).searchParams.get("approval");
    const sender = {
      ...extension,
      url,
      tab: { id: 20 },
    } as chrome.runtime.MessageSender;
    expect((await ui("approval", { id }, sender)).result).toMatchObject({
      id,
      origin: page.origin,
      method: "connect",
      accounts: [],
    });
    expect(
      (await ui("decide", { id, approve: true, accounts: [account] }, sender))
        .error?.code,
    ).toBe(4100);
    expect((await ui("unlock", { password: pass }, page)).error?.code).toBe(
      4100,
    );
    expect(
      (await ui("unlock", { password: "wrong password" }, sender)).error,
    ).toBeDefined();
    expect((await ui("state")).result).toMatchObject({ unlocked: false });
    expect((await request({ method: "getSession" })).result).toMatchObject({
      accounts: [],
    });
    expect((saved.wallet as { grants?: object }).grants).toBeUndefined();
    expect(settled).not.toHaveBeenCalled();
    expect(
      (await ui("unlock", { password: pass }, sender)).error,
    ).toBeUndefined();
    expect((await ui("approval", { id }, sender)).result).toMatchObject({
      id,
      accounts: [
        expect.objectContaining({ address: account }),
        expect.any(Object),
      ],
    });
    expect((await request({ method: "getSession" })).result).toMatchObject({
      accounts: [],
    });
    expect((saved.wallet as { grants?: object }).grants).toBeUndefined();
    expect(mock.change).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    await decideNext();
    expect((await connecting).result).toMatchObject({
      accounts: [publicAccount(secret)],
    });
    expect(mock.change).toHaveBeenCalledExactlyOnceWith(
      10,
      {
        kind: "change",
        session: {
          networkHash: "00".repeat(32),
          accounts: [publicAccount(secret)],
        },
      },
      { documentId: "doc1" },
    );
  });
  it.each([
    "close",
    "tab close",
    "popup navigation",
    "page navigation",
    "disconnect",
    "lock",
  ])(
    "%s cancels a locked connect even if unlock later succeeds",
    async (action) => {
      await ui("lock");
      const connecting = request({ method: "connect" });
      await vi.waitFor(() => expect(windows).toHaveLength(1));
      const url = windows[0]!.url;
      const id = new URL(url).searchParams.get("approval");
      if (action === "close") removed(30);
      if (action === "tab close") tabRemoved(20);
      if (action === "popup navigation")
        navigated({ frameId: 0, tabId: 20, url: extension.url });
      if (action === "page navigation")
        navigated({ frameId: 0, tabId: 10, documentId: "doc2" });
      if (action === "disconnect") await request({ method: "disconnect" });
      if (action === "lock") await ui("lock");
      expect((await connecting).error?.code).toBe(4001);
      await ui("unlock", { password: pass });
      expect((await ui("approval", { id })).error?.code).toBe(4001);
      expect(
        (
          await ui("decide", { id, approve: true, accounts: [account] }, {
            ...extension,
            url,
            tab: { id: 20 },
          } as chrome.runtime.MessageSender)
        ).error?.code,
      ).toBe(4001);
      expect((saved.wallet as { grants?: object }).grants).toBeUndefined();
      expect((await request({ method: "getSession" })).result).toMatchObject({
        accounts: [],
      });
      expect(mock.change).not.toHaveBeenCalled();
    },
  );
  it("disconnect during expiry cleanup cannot revive the connection preflight", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    const gate = deferred();
    mock.write.mockClear().mockImplementationOnce(() => gate.promise);
    const networkGate = deferred();
    mock.networkInfo.mockImplementationOnce(async () => {
      await networkGate.promise;
      return { networkHash: mock.hash };
    });
    const connecting = request({ method: "connect" });
    await vi.waitFor(() => expect(mock.write).toHaveBeenCalledTimes(1));
    await request({ method: "disconnect" });
    gate.release();
    networkGate.release();
    expect((await connecting).error?.code).toBe(4001);
    expect(windows).toHaveLength(0);
  });
  it("rejects a document that navigated during locked connection preflight", async () => {
    await ui("lock");
    const gate = deferred();
    mock.networkInfo.mockClear().mockImplementationOnce(async () => {
      await gate.promise;
      return { networkHash: mock.hash };
    });
    const connecting = request({ method: "connect" });
    await vi.waitFor(() => expect(mock.networkInfo).toHaveBeenCalledTimes(1));
    mock.frame.mockResolvedValue({ documentId: "doc2", url: page.url });
    navigated({ frameId: 0, tabId: 10, documentId: "doc2" });
    gate.release();
    expect((await connecting).error?.code).toBe(4001);
    expect(windows).toHaveLength(0);
  });
  it("explicit lock preempts unlock persistence and cancels its pending connection", async () => {
    await ui("lock");
    const connecting = request({ method: "connect" });
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    const gate = deferred();
    mock.write.mockClear().mockImplementationOnce(() => gate.promise);
    const unlocking = ui("unlock", { password: pass });
    await vi.waitFor(() => expect(mock.write).toHaveBeenCalledTimes(1));
    await ui("lock");
    gate.release();
    expect((await unlocking).error?.code).toBe(4001);
    expect((await connecting).error?.code).toBe(4001);
    expect((await ui("state")).result).toMatchObject({ unlocked: false });
    expect((saved.wallet as { grants?: object }).grants).toBeUndefined();
  });
  it.each([
    { documentId: "doc2", url: page.url },
    { documentId: "doc1", url: "https://other.example/" },
    null,
  ])(
    "rejects a changed or closed document after durable consume, keeping permission consumed (%j)",
    async (frame) => {
      await approve("connect");
      const signed = (
        await approve(
          "signTransaction",
          toHex0x(serializeTransaction(await transaction())),
        )
      ).result as SignTransactionResult;
      const gate = deferred();
      mock.write.mockClear().mockImplementationOnce(() => gate.promise);
      const submitting = submit(signed);
      await vi.waitFor(() => expect(mock.write).toHaveBeenCalledTimes(1));
      mock.frame.mockResolvedValue(frame);
      navigated({ frameId: 0, tabId: 10, documentId: "doc2" });
      gate.release();
      expect((await submitting).error?.code).toBe(4100);
      expect(mock.send).not.toHaveBeenCalled();
      expect((saved.wallet as { approvals: unknown[] }).approvals).toHaveLength(
        0,
      );
      mock.frame.mockResolvedValue({ documentId: "doc1", url: page.url });
      expect((await submit(signed)).error?.code).toBe(4100);
    },
  );
  it.each([
    ["generate", "encryption"],
    ["restore", "encryption"],
    ["generate", "persistence"],
    ["restore", "persistence"],
  ])(
    "lock during %s %s prevents activation while keeping the persisted vault recoverable",
    async (mode, boundary) => {
      saved = {};
      await boot();
      const gate = deferred();
      const stage = boundary === "encryption" ? mock.encrypt : mock.write;
      stage.mockClear().mockImplementationOnce(() => gate.promise);
      const creating = ui("create", {
        password: pass,
        ...(mode === "restore" ? { mnemonic: secretVault.mnemonic } : {}),
      });
      await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
      expect((await ui("lock")).error).toBeUndefined();
      gate.release();
      expect((await creating).error?.code).toBe(4001);
      expect((await ui("state")).result).toMatchObject({
        exists: true,
        unlocked: false,
        accounts: [],
      });
      expect((saved.wallet as { envelope?: unknown }).envelope).toBeDefined();
      expect((await ui("unlock", { password: pass })).error).toBeUndefined();
      if (mode === "restore")
        expect((await ui("state")).result).toMatchObject({
          accounts: [expect.objectContaining({ address: account })],
        });
    },
  );
  it("disconnect cancels its own in-flight connection preflight without global invalidation or events", async () => {
    const gate = deferred();
    mock.networkInfo.mockClear().mockImplementationOnce(async () => {
      await gate.promise;
      return { networkHash: mock.hash };
    });
    const connecting = request({ method: "connect" });
    await vi.waitFor(() => expect(mock.networkInfo).toHaveBeenCalledTimes(1));
    expect(windows).toHaveLength(0);
    expect((await request({ method: "disconnect" })).error).toBeUndefined();
    expect(mock.change).not.toHaveBeenCalled();
    gate.release();
    expect((await connecting).error?.code).toBe(4001);
    expect(windows).toHaveLength(0);
    expect((await approve("connect")).error).toBeUndefined();
  });
  it("keeps recentFailure boundsExceeded advisory pending across reopen and status checks without automatic funding or resubmission", async () => {
    mock.waitReceipt.mockRejectedValueOnce(
      new Error("Timed out: recentFailure boundsExceeded at token contract"),
    );
    const tx = toHex0x(serializeTransaction(await transaction()));
    const reply = await ui("sendTransfer", {
      account,
      transaction: tx,
      networkHash: "00".repeat(32),
    });
    const result = reply.result as { hash: string; status: string };
    expect(result.status).toBe(PENDING_TRANSFER_ADVISORY);
    expect(result.status).toContain("Execution not yet confirmed");
    expect(result.status).toContain("Use Send HOG to the token address");
    await boot();
    await ui("unlock", { password: pass });
    const observed = (
      await ui("observeTransfer", {
        hash: result.hash,
        networkHash: "00".repeat(32),
      })
    ).result as { outgoing: OutgoingTransfer[] };
    expect(observed.outgoing[0]).toMatchObject({
      hash: result.hash,
      outcome: "submitted",
      advisory: expect.stringContaining("boundsExceeded"),
    });
    expect(
      (
        await ui("sendTransfer", {
          account,
          transaction: tx,
          networkHash: "00".repeat(32),
        })
      ).error?.code,
    ).toBe(-32002);
    expect(mock.send).toHaveBeenCalledTimes(1);
    expect(mock.airdrop).not.toHaveBeenCalled();
  });
  it("a connected origin disconnect cannot cancel another origin pending signature", async () => {
    const other = {
      ...page,
      origin: "https://other.example",
      url: "https://other.example/",
      documentId: "other",
      tab: { id: 11 },
    } as chrome.runtime.MessageSender;
    mock.frame.mockResolvedValue({ documentId: "other", url: other.url });
    const otherConnection = request({ method: "connect" }, other);
    await decideNext();
    expect((await otherConnection).error).toBeUndefined();
    mock.frame.mockResolvedValue({ documentId: "doc1", url: page.url });
    await approve("connect");
    const signing = request({
      method: "signTransaction",
      params: {
        account,
        networkHash: "00".repeat(32),
        transaction: toHex0x(serializeTransaction(await transaction())),
      },
    });
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    await request({ method: "disconnect" }, other);
    await decideNext();
    expect((await signing).error).toBeUndefined();
  });
  it("only changed account sessions lose their signature permissions", async () => {
    await approve("connect");
    const signed = (
      await approve(
        "signTransaction",
        toHex0x(serializeTransaction(await transaction())),
      )
    ).result as SignTransactionResult;
    mock.change.mockClear();
    await ui("addAccount");
    expect(mock.change).not.toHaveBeenCalled();
    expect((saved.wallet as { approvals: unknown[] }).approvals).toHaveLength(
      1,
    );
    await ui("removeAccount", { account });
    expect((saved.wallet as { approvals: unknown[] }).approvals).toHaveLength(
      0,
    );
    expect((await submit(signed)).error?.code).toBe(4100);
  });
  it("failed approval consumption does not broadcast or mutate committed state, and concurrent retries broadcast only once", async () => {
    await approve("connect");
    const signed = (
      await approve(
        "signTransaction",
        toHex0x(serializeTransaction(await transaction())),
      )
    ).result as SignTransactionResult;
    const before = structuredClone(saved);
    mock.write.mockRejectedValueOnce(new Error("Disk full"));
    expect((await submit(signed)).error).toBeDefined();
    expect(saved).toEqual(before);
    expect(mock.send).not.toHaveBeenCalled();
    const replies = await Promise.all([submit(signed), submit(signed)]);
    expect(replies.filter((r) => r.result)).toHaveLength(1);
    expect(replies.filter((r) => r.error?.code === 4100)).toHaveLength(1);
    expect(mock.send).toHaveBeenCalledTimes(1);
  });
  it("adds and removes accounts without reusing a derived index, and exports imported keys only after reauthentication", async () => {
    const added = (await ui("addAccount")).result as {
      accounts: { address: string; index?: number }[];
    };
    expect(added.accounts[1]!.index).toBe(1);
    await ui("removeAccount", { account: added.accounts[1]!.address });
    const next = (await ui("addAccount")).result as {
      accounts: { index?: number }[];
    };
    expect(next.accounts[1]!.index).toBe(2);
    const key = "11".repeat(32);
    expect((await ui("addAccount", { key })).error).toBeUndefined();
    expect((await ui("addAccount", { key })).error?.code).toBe(-32602);
    expect(
      (await ui("export", { password: "wrong password" })).error,
    ).toBeDefined();
    const exported = (await ui("export", { password: pass })).result as {
      importedKeys: { key: string }[];
    };
    expect(exported.importedKeys[0]!.key).toBe(key);
    expect(JSON.stringify(saved)).not.toContain(key);
  });
  it("fails closed at absolute session expiry and on RPC identity drift", async () => {
    mock.hash = new Uint8Array(32).fill(1);
    const drift = await message(
      {
        kind: "provider",
        id: crypto.randomUUID(),
        request: { method: "connect" },
      },
      page,
    );
    expect(drift.error?.code).toBe(4901);
    expect(windows).toHaveLength(0);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    expect((await ui("export", { password: pass })).error?.code).toBe(4100);
  });
  it("persists signed approval before returning but invalidates it permanently on worker restart", async () => {
    await approve("connect");
    const wallet = accountOf(secret);
    const tx = await prepareTransaction(
      { getChainTip: async () => ({ height: blockHeight(1n) }) as never },
      wallet,
      {
        invocation: defaultWalletAdapter.createRootInvocation(wallet.address, {
          gasLimit: gasAmount(100000n),
          invocation: ERC20.transfer.invocation(
            contractAddress(new Uint8Array(32).fill(1)),
            gasAmount(50000n),
            { receiver: wallet.address, amount: 1n },
          ),
        }),
      },
    );
    const signature = (
      await approve("signTransaction", toHex0x(serializeTransaction(tx)))
    ).result as { signedTransaction: string; hash: string };
    expect(JSON.stringify(saved)).toContain(signature.signedTransaction);
    expect(mock.send).not.toHaveBeenCalled();
    await boot();
    const submit = () =>
      message(
        {
          kind: "provider",
          id: crypto.randomUUID(),
          request: {
            method: "submitTransaction",
            params: {
              account,
              networkHash: "00".repeat(32),
              signedTransaction: signature.signedTransaction,
            },
          },
        },
        page,
      );
    expect((await submit()).error?.code).toBe(4100);
    await ui("unlock", { password: pass });
    expect((await submit()).error?.code).toBe(4100);
    expect(mock.send).not.toHaveBeenCalled();
    await ui("revoke", { origin: page.origin });
    expect((await submit()).error?.code).toBe(4100);
    expect(JSON.stringify(saved)).not.toContain(secret.key);
    expect(JSON.stringify(saved)).not.toContain(secretVault.mnemonic);
  });
  it("runs the real SDK adapter through sign, caller persistence, and single-use submit without a spurious change event", async () => {
    await approve("connect");
    const listeners = new Set<(session: WalletSession) => void>();
    mock.change.mockClear();
    mock.change.mockImplementation((_tab, message) => {
      if (message.kind === "change")
        for (const listener of listeners) listener(message.session);
    });
    const provider: WalletProvider = {
      info: { id: "test", name: "Test", version: "1.0.0" },
      request: async (value) => {
        const reply = await request(value);
        if (reply.error)
          throw Object.assign(new Error(reply.error.message), {
            code: reply.error.code,
          });
        return reply.result;
      },
      on: (_event, listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const adapter = createProviderWalletClient({
      provider,
      account: publicAccount(secret),
      networkHash: "00".repeat(32),
      client: await createGroundhogClient({ transport: new MockTransport() }),
    });
    const signing = adapter.signTransaction(await transaction());
    await decideNext();
    const signed = structuredClone(await signing);
    expect(JSON.stringify(saved)).toContain(signed.signedTransaction);
    expect(mock.change).not.toHaveBeenCalled();
    mock.send.mockImplementation(async (stx) => {
      expect((saved.wallet as { approvals: unknown[] }).approvals).toHaveLength(
        0,
      );
      return hashSignedTransaction(stx);
    });
    expect(await adapter.submitTransaction(signed)).toEqual({
      hash: signed.hash,
    });
    expect((await submit(signed)).error?.code).toBe(4100);
    expect(mock.send).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
  it("an unconnected origin cannot cancel another origin approval or emit its session change", async () => {
    const connecting = request({ method: "connect" });
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    const stranger = {
      ...page,
      origin: "https://other.example",
      url: "https://other.example/",
      documentId: "other",
      tab: { id: 11 },
    } as chrome.runtime.MessageSender;
    expect(
      (await request({ method: "disconnect" }, stranger)).error,
    ).toBeUndefined();
    expect(mock.change).not.toHaveBeenCalled();
    await decideNext();
    expect((await connecting).error).toBeUndefined();
  });
  it.each(["lock", "disconnect", "revoke", "network"] as const)(
    "%s permanently retires old approved bytes even after reconnect",
    async (operation) => {
      await approve("connect");
      const signed = (
        await approve(
          "signTransaction",
          toHex0x(serializeTransaction(await transaction())),
        )
      ).result as SignTransactionResult;
      if (operation === "disconnect") await request({ method: "disconnect" });
      else
        await ui(
          operation,
          operation === "revoke"
            ? { origin: page.origin }
            : operation === "network"
              ? { network: "localnet" }
              : {},
        );
      if (operation === "lock") await ui("unlock", { password: pass });
      await approve("connect");
      expect((await submit(signed)).error?.code).toBe(4100);
      expect((saved.wallet as { approvals: unknown[] }).approvals).toHaveLength(
        0,
      );
    },
  );
  it("replaces the latest approval and consumes it even after an ambiguous broadcast", async () => {
    await approve("connect");
    const first = (
      await approve(
        "signTransaction",
        toHex0x(serializeTransaction(await transaction())),
      )
    ).result as SignTransactionResult;
    const second = (
      await approve(
        "signTransaction",
        toHex0x(serializeTransaction(await transaction())),
      )
    ).result as SignTransactionResult;
    expect((saved.wallet as { approvals: unknown[] }).approvals).toHaveLength(
      1,
    );
    expect((await submit(first)).error?.code).toBe(4100);
    mock.send.mockRejectedValueOnce(new Error("Ambiguous broadcast"));
    expect((await submit(second)).error).toBeDefined();
    expect((await submit(second)).error?.code).toBe(4100);
    expect(mock.send).toHaveBeenCalledTimes(1);
  });
  it("does not publish or authorize an approval whose storage write failed", async () => {
    await approve("connect");
    const signing = request({
      method: "signTransaction",
      params: {
        account,
        networkHash: "00".repeat(32),
        transaction: toHex0x(serializeTransaction(await transaction())),
      },
    });
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    const url = windows.pop()!.url,
      id = new URL(url).searchParams.get("approval");
    const before = structuredClone(saved);
    mock.write.mockRejectedValueOnce(new Error("Quota failure"));
    expect(
      (
        await ui("decide", { id, approve: true }, {
          ...extension,
          url,
          tab: { id: 20 },
        } as chrome.runtime.MessageSender)
      ).error,
    ).toBeDefined();
    expect(saved).toEqual(before);
    removed(30);
    expect((await signing).error?.code).toBe(4001);
    expect(mock.send).not.toHaveBeenCalled();
  });
  it("skips a next-index seed imported earlier and advances the encrypted index atomically", async () => {
    const key = deriveKey(secretVault.mnemonic, 1);
    await ui("addAccount", { key });
    const before = structuredClone(saved);
    mock.write.mockRejectedValueOnce(new Error("Storage failure"));
    expect((await ui("addAccount")).error).toBeDefined();
    expect(saved).toEqual(before);
    const result = (await ui("addAccount")).result as {
      accounts: { index?: number }[];
    };
    expect(result.accounts[2]!.index).toBe(2);
  });
  it("retains outgoing recovery hashes across closure/restart and observes without signing or broadcasting again", async () => {
    const tx = toHex0x(serializeTransaction(await transaction()));
    mock.send.mockRejectedValueOnce(new Error("Network timeout"));
    const result = (
      await ui("sendTransfer", {
        account,
        networkHash: "00".repeat(32),
        transaction: tx,
      })
    ).result as { hash: string };
    expect(result.hash).toMatch(/^0x/);
    expect(JSON.stringify(saved)).not.toContain("signedTransaction");
    await boot();
    await ui("unlock", { password: pass });
    const state = (await ui("state")).result as {
      outgoing: OutgoingTransfer[];
    };
    expect(state.outgoing[0]).toMatchObject({
      hash: result.hash,
      outcome: "unknown",
      account,
    });
    expect(
      (
        await ui("sendTransfer", {
          account,
          networkHash: "00".repeat(32),
          transaction: tx,
        })
      ).error?.code,
    ).toBe(-32002);
    mock.receipt.mockResolvedValueOnce({ execResult: 0 });
    expect(
      (
        await ui("observeTransfer", {
          hash: result.hash,
          networkHash: "00".repeat(32),
        })
      ).error,
    ).toBeUndefined();
    expect(mock.send).toHaveBeenCalledTimes(1);
    expect(
      (
        await ui("ackTransfer", {
          hash: result.hash,
          networkHash: "00".repeat(32),
        })
      ).error,
    ).toBeDefined();
    await ui("ackTransfer", {
      hash: result.hash,
      networkHash: "00".repeat(32),
      confirmRisk: true,
    });
    expect(
      ((await ui("state")).result as { outgoing: unknown[] }).outgoing,
    ).toHaveLength(0);
  });
  it("never broadcasts a wallet transfer if its recovery record cannot be persisted", async () => {
    mock.write.mockRejectedValueOnce(new Error("Disk full"));
    const before = structuredClone(saved);
    expect(
      (
        await ui("sendTransfer", {
          account,
          networkHash: "00".repeat(32),
          transaction: toHex0x(serializeTransaction(await transaction())),
        })
      ).error,
    ).toBeDefined();
    expect(mock.send).not.toHaveBeenCalled();
    expect(saved).toEqual(before);
  });
  it("retires a validated terminal airdrop failure so the next explicit request uses a fresh nonce", async () => {
    mock.airdrop.mockResolvedValue({
      status: { result: "reverted" },
      txHash: new Uint8Array(32),
    });
    expect((await ui("airdrop", { account })).error).toBeDefined();
    expect((await ui("airdrop", { account })).error).toBeDefined();
    expect(mock.airdrop.mock.calls[0]![0].clientNonce).not.toEqual(
      mock.airdrop.mock.calls[1]![0].clientNonce,
    );
  });
  it("rejects content-script privileged messages and approvals from the wrong window", async () => {
    expect((await ui("export", { password: pass }, page)).error?.code).toBe(
      4100,
    );
    expect(
      (await ui("state", {}, { ...extension, url: "file:///index.html" })).error
        ?.code,
    ).toBe(4100);
    const response = message(
      {
        kind: "provider",
        id: crypto.randomUUID(),
        request: { method: "connect" },
      },
      page,
    );
    await vi.waitFor(() => expect(windows.length).toBe(1));
    const id = new URL(windows[0]!.url).searchParams.get("approval");
    expect(
      (await ui("decide", { id, approve: true, accounts: [account] })).error
        ?.code,
    ).toBe(4100);
    removed(30);
    expect((await response).error?.code).toBe(4001);
  });
  it("cancels approval when the original document navigates", async () => {
    const response = message(
      {
        kind: "provider",
        id: crypto.randomUUID(),
        request: { method: "connect" },
      },
      page,
    );
    await vi.waitFor(() => expect(windows.length).toBe(1));
    navigated({ frameId: 0, tabId: 10, documentId: "doc2" });
    expect((await response).error?.code).toBe(4001);
  });
  it("reuses the persisted airdrop nonce across ambiguous failure and worker restart", async () => {
    mock.airdrop.mockRejectedValueOnce(new Error("Network timeout"));
    expect((await ui("airdrop", { account })).error).toBeDefined();
    const first = mock.airdrop.mock.calls[0]![0].clientNonce;
    await boot();
    await ui("unlock", { password: pass });
    mock.airdrop.mockResolvedValueOnce({
      status: { result: "ok" },
      txHash: new Uint8Array(32),
    });
    expect((await ui("airdrop", { account })).error).toBeUndefined();
    expect(mock.airdrop.mock.calls[1]![0].clientNonce).toEqual(first);
  });
});
