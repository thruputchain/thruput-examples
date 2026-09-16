import type {
  ProviderRequest,
  WalletSession,
} from "@groundhogchain/client/provider";
import {
  addressFromHex,
  hashFromHex,
  deserializeSignedTransaction,
  toHex0x,
} from "@groundhogchain/client";
import { ExecResult } from "@groundhogchain/protocol";
import {
  decryptVault,
  encryptVault,
  newVault,
  deriveKey,
  publicAccount,
  hex,
  unhex,
  type Vault,
  type SecretAccount,
} from "./vault";
import {
  address,
  canSubmit,
  exact,
  fail,
  pageOrigin,
  record,
  requestSchema,
  text,
  WalletError,
  MAX_UNSIGNED_HEX,
  type SignedApproval,
} from "./policy";
import {
  clientFor,
  NETWORKS,
  nativeToken,
  portfolio,
  tokenMetadata,
  transferTransaction,
  requireAirdropSuccess,
  type Network,
} from "./network";
import {
  inspectTransaction,
  signApproved,
  type TransactionReview,
} from "./transactions";
import {
  replaceApproval,
  PENDING_TRANSFER_ADVISORY,
  assertTransferAvailable,
} from "./lifecycle";
import { isEnvelope, parseStored, type Stored } from "./storage";

interface Grant {
  networkHash: string;
  accounts: string[];
}
interface Pending {
  id: string;
  requestId: string;
  origin: string;
  sender: chrome.runtime.MessageSender;
  networkHash: string;
  epoch: number;
  originEpoch: number;
  request: ProviderRequest;
  review?: TransactionReview;
  windowId?: number;
  approvalTab?: number;
  granting?: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
let stored: Stored = parseStored(undefined, chrome.runtime.getURL("/"));
let vault: Vault | undefined, password: string | undefined;
let expires = 0,
  epoch = 0;
const pending = new Map<string, Pending>();
const documents = new Map<string, chrome.runtime.MessageSender>();
const snapshots = new Map<string, string>();
const originEpochs = new Map<string, number>();
const revoked = new Set<string>();
// Only signatures returned by this worker can be submitted. Keep hashes, not
// another copy of the signed bytes; durable approvals still enforce exact bytes.
const eligible = new Map<string, string>();
const approvalScope = (
  a: Pick<SignedApproval, "origin" | "account" | "networkHash">,
) => JSON.stringify([a.origin, a.account, a.networkHash]);
const isEligible = (a: SignedApproval) =>
  eligible.get(approvalScope(a)) === a.hash;
let grants: Record<string, Grant> = {};
const originEpoch = (origin: string) => originEpochs.get(origin) || 0;
let storeQueue: Promise<void> = Promise.resolve();
function updateStore(change: (next: Stored) => void): Promise<void> {
  const task = storeQueue.then(async () => {
    const next = structuredClone(stored);
    change(next);
    await chrome.storage.local.set({ wallet: next });
    stored = next;
    for (const [scope, hash] of eligible)
      if (
        !next.approvals.some(
          (a) => approvalScope(a) === scope && a.hash === hash,
        )
      )
        eligible.delete(scope);
  });
  storeQueue = task.catch(() => {});
  return task;
}
const ready = (async () => {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
  const data = await chrome.storage.local.get("wallet");
  stored = parseStored(data.wallet, chrome.runtime.getURL("/"));
  await updateStore(() => {});
  await Promise.all(
    (await chrome.tabs.query({})).map(async (tab) => {
      if (tab.id)
        await chrome.tabs
          .sendMessage(
            tab.id,
            {
              kind: "change",
              session: { networkHash: stored.pin, accounts: [] },
            },
            { frameId: 0 },
          )
          .catch(() => {});
    }),
  );
})();
const unlocked = () => Boolean(vault && Date.now() < expires);
function requireUnlock() {
  if (!unlocked()) {
    // A locked connect may be waiting for unlock; only expire an old session.
    if (vault || expires || stored.approvals.length) void lock();
    fail(4100, "Unlock Thruput Wallet first");
  }
  return vault!;
}
function secretFor(account: string): SecretAccount {
  const secret = requireUnlock().accounts.find(
    (s) => publicAccount(s).address === account,
  );
  if (!secret) fail(4100, "Account is unavailable");
  return secret;
}
function session(origin: string): WalletSession {
  const grant = grants[origin];
  return {
    networkHash: stored.pin,
    accounts:
      unlocked() && !revoked.has(origin) && grant?.networkHash === stored.pin
        ? vault!.accounts
            .map(publicAccount)
            .filter((a) => grant.accounts.includes(a.address))
        : [],
  };
}
let publications: Promise<void> = Promise.resolve();
function publish(): Promise<void> {
  const changes: {
    sender: chrome.runtime.MessageSender;
    session: WalletSession;
  }[] = [];
  for (const sender of documents.values()) {
    if (sender.tab?.id && sender.documentId && sender.origin) {
      const current = session(sender.origin),
        snapshot = JSON.stringify(current);
      if (snapshots.get(sender.documentId) === snapshot) continue;
      snapshots.set(sender.documentId, snapshot);
      changes.push({ sender, session: current });
    }
  }
  refreshUi();
  // Even a deduplicated publication waits for earlier change deliveries. The
  // content script acknowledges only after queuing its page-side change event.
  publications = publications.then(async () => {
    await Promise.all(
      changes.map(({ sender, session }) =>
        chrome.tabs
          .sendMessage(
            sender.tab!.id!,
            { kind: "change", session },
            { documentId: sender.documentId! },
          )
          .catch(() => {}),
      ),
    );
  });
  return publications;
}
function refreshUi() {
  void chrome.runtime.sendMessage({ kind: "stateChanged" }).catch(() => {});
}
function rejectPending(item: Pending, message = "Request canceled") {
  if (!pending.delete(item.id)) return;
  if (item.granting) {
    revokeGrant(item.origin);
    void publish();
  }
  clearTimeout(item.timer);
  item.reject(new WalletError(4001, message));
  if (item.windowId) void chrome.windows.remove(item.windowId).catch(() => {});
}
function revokeGrant(origin: string) {
  for (const approval of stored.approvals)
    if (approval.origin === origin) eligible.delete(approvalScope(approval));
  revoked.add(origin);
  delete grants[origin];
  originEpochs.set(origin, originEpoch(origin) + 1);
}
function invalidate() {
  eligible.clear();
  epoch++;
  for (const item of pending.values()) rejectPending(item);
  publish();
}
function lock() {
  if (!vault && expires === 0 && stored.approvals.length === 0) {
    invalidate();
    return Promise.resolve();
  }
  vault = undefined;
  password = undefined;
  expires = 0;
  invalidate();
  const clearing = updateStore((next) => {
    next.approvals = [];
  });
  void clearing.catch(() => {});
  return clearing;
}
async function activate(value: Vault, pass: string, start: number) {
  if (start !== epoch) fail(4001, "Unlock canceled");
  await updateStore((next) => {
    next.approvals = [];
  });
  if (start !== epoch) fail(4001, "Unlock canceled");
  vault = value;
  password = pass;
  expires = Date.now() + 10 * 60_000;
  await chrome.alarms.create("lock", { when: expires });
  publish();
}
async function disconnect(origin: string) {
  const requests = [...pending.values()].filter((p) => p.origin === origin);
  const cleanup =
    Boolean(grants[origin]) ||
    stored.approvals.some((a) => a.origin === origin) ||
    requests.some((p) => p.granting || p.request.method === "signTransaction");
  revokeGrant(origin);
  if (!cleanup && !requests.length) return;
  for (const item of requests) rejectPending(item);
  const delivery = publish();
  try {
    if (cleanup)
      await updateStore((next) => {
        next.approvals = next.approvals.filter((a) => a.origin !== origin);
      });
  } finally {
    await delivery;
  }
}
async function networkCheck(expected = stored.pin) {
  if (!stored.pin)
    fail(
      4901,
      "Stored network settings are damaged. Select the network again.",
    );
  const network = stored.network;
  const hash = hex(
    (await (await clientFor(network)).getNetworkInfo()).networkHash,
  );
  if (
    stored.network !== network ||
    hash !== expected ||
    stored.pin !== expected
  )
    fail(
      4901,
      "RPC network identity changed. Select the network again to reconnect.",
    );
  return hash;
}
async function liveDocument(item: Pending) {
  if (
    !pending.has(item.id) ||
    item.epoch !== epoch ||
    item.originEpoch !== originEpoch(item.origin) ||
    item.networkHash !== stored.pin
  )
    fail(4001, "Approval expired");
  await assertDocument(item.sender);
  if (
    !pending.has(item.id) ||
    item.epoch !== epoch ||
    item.originEpoch !== originEpoch(item.origin)
  )
    fail(4001, "Approval expired");
}
async function assertDocument(sender: chrome.runtime.MessageSender) {
  const frame = await chrome.webNavigation.getFrame({
    tabId: sender.tab!.id!,
    frameId: 0,
  });
  if (
    !frame ||
    frame.documentId !== sender.documentId ||
    new URL(frame.url).origin !== sender.origin
  )
    fail(4100, "The requesting document has navigated");
}
function assertGrant(origin: string, account: string, hash: string) {
  requireUnlock();
  if (hash !== stored.pin) fail(4901, "Wrong network");
  const grant = grants[origin];
  if (
    revoked.has(origin) ||
    !grant ||
    grant.networkHash !== hash ||
    !grant.accounts.includes(account)
  )
    fail(4100, "Account is not connected to this site");
  secretFor(account);
}
async function approveRequest(
  request: ProviderRequest,
  id: string,
  sender: chrome.runtime.MessageSender,
  origin: string,
) {
  if (request.method !== "connect") requireUnlock();
  else if (vault && !unlocked()) void lock();
  if (
    pending.size >= 8 ||
    [...pending.values()].some((p) => p.origin === origin)
  )
    fail(-32002, "An approval is already pending");
  return new Promise((resolve, reject) => {
    const approvalId = crypto.randomUUID();
    const item: Pending = {
      id: approvalId,
      requestId: id,
      origin,
      sender,
      request,
      networkHash: stored.pin,
      epoch,
      originEpoch: originEpoch(origin),
      resolve,
      reject,
      timer: setTimeout(
        () => rejectPending(item, "Approval timed out"),
        115000,
      ),
    };
    pending.set(approvalId, item);
    // Reserve the same bounded, document-bound slot for preflight and approval.
    // Cancellation, navigation and timeout can retire it before any popup exists.
    void (async () => {
      await networkCheck(item.networkHash);
      await liveDocument(item);
      item.review =
        request.method === "signTransaction"
          ? inspectTransaction(
              request.params.transaction,
              secretFor(request.params.account),
            ).review
          : undefined;
      if (request.method === "signTransaction")
        eligible.delete(approvalScope({ origin, ...request.params }));
      let window: chrome.windows.Window | undefined;
      try {
        window = await chrome.windows.create({
          url: chrome.runtime.getURL(`index.html?approval=${approvalId}`),
          type: "popup",
          width: 460,
          height: 720,
        });
      } catch {
        rejectPending(item, "Could not open approval window");
        return;
      }
      if (!window) {
        rejectPending(item, "Could not open approval window");
        return;
      }
      if (!pending.has(approvalId)) {
        if (window.id) void chrome.windows.remove(window.id).catch(() => {});
        return;
      }
      item.windowId = window.id;
      item.approvalTab = window.tabs?.[0]?.id;
    })().catch((error) => {
      if (!pending.delete(item.id)) return;
      clearTimeout(item.timer);
      item.reject(error);
    });
  });
}
async function provider(
  value: unknown,
  id: string,
  sender: chrome.runtime.MessageSender,
) {
  const origin = pageOrigin(sender),
    request = requestSchema(value);
  documents.set(sender.documentId!, sender);
  if (!snapshots.has(sender.documentId!))
    snapshots.set(sender.documentId!, JSON.stringify(session(origin)));
  if (documents.size > 256) {
    const oldest = documents.keys().next().value!;
    documents.delete(oldest);
    snapshots.delete(oldest);
  }
  switch (request.method) {
    case "getSession":
      return session(origin);
    case "getCapabilities":
      assertGrant(origin, request.params.account, request.params.networkHash);
      return {
        account: request.params.account,
        networkHash: request.params.networkHash,
        atomicBatch: { maxCalls: 16 },
      };
    case "disconnect":
      await disconnect(origin);
      return null;
    case "connect":
      return approveRequest(request, id, sender, origin);
    case "signTransaction":
      assertGrant(origin, request.params.account, request.params.networkHash);
      return approveRequest(request, id, sender, origin);
    case "submitTransaction": {
      const p = request.params;
      assertGrant(origin, p.account, p.networkHash);
      const approval = stored.approvals.find(
        (a) =>
          isEligible(a) && canSubmit(a, { origin, ...p }, unlocked(), true),
      );
      if (!approval)
        fail(4100, "These exact signed bytes were not approved for this site");
      const startEpoch = epoch;
      const startOriginEpoch = originEpoch(origin);
      await networkCheck(p.networkHash);
      if (startEpoch !== epoch) fail(4100, "Wallet state changed");
      assertGrant(origin, p.account, p.networkHash);
      const client = await clientFor(stored.network);
      await assertDocument(sender);
      if (startEpoch !== epoch) fail(4100, "Wallet state changed");
      assertGrant(origin, p.account, p.networkHash);
      await updateStore((next) => {
        if (startEpoch !== epoch || startOriginEpoch !== originEpoch(origin))
          fail(4100, "Wallet session changed");
        assertGrant(origin, p.account, p.networkHash);
        const index = next.approvals.findIndex(
          (a) => isEligible(a) && canSubmit(a, { origin, ...p }, true, true),
        );
        if (index < 0)
          fail(4100, "Approval was already consumed or invalidated");
        next.approvals.splice(index, 1);
      });
      await assertDocument(sender);
      if (startEpoch !== epoch || startOriginEpoch !== originEpoch(origin))
        fail(4100, "Wallet session changed");
      assertGrant(origin, p.account, p.networkHash);
      const result = await client.sendTransaction(
        deserializeSignedTransaction(unhex(p.signedTransaction.slice(2))),
      );
      if (toHex0x(result) !== approval.hash)
        fail(-32603, "RPC returned an unexpected transaction hash");
      return { hash: approval.hash };
    }
  }
}
function trusted(sender: chrome.runtime.MessageSender) {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url ||
    !sender.url.startsWith(chrome.runtime.getURL("index.html")) ||
    new URL(sender.url).pathname !== "/index.html"
  )
    fail(4100, "Trusted wallet UI required");
}
function uiState() {
  return {
    exists: Object.hasOwn(stored, "envelope"),
    unlocked: unlocked(),
    network: stored.network,
    networkHash: stored.pin,
    expires,
    accounts: unlocked()
      ? vault!.accounts.map((s) => ({
          ...publicAccount(s),
          name: s.name,
          index: s.index,
        }))
      : [],
    sites: Object.keys(grants),
    outgoing: unlocked() ? stored.outgoing : [],
    recoveryBlocked: stored.recoveryBlocked === true,
  };
}
async function saveSecrets(next: Vault) {
  const startEpoch = epoch;
  const pass = password!;
  const envelope = await encryptVault(next, pass);
  if (epoch !== startEpoch || !unlocked())
    fail(4100, "Wallet locked during update");
  const available = new Set(next.accounts.map((a) => publicAccount(a).address));
  const changedOrigins = new Set<string>();
  for (const [origin, grant] of Object.entries(grants)) {
    if (grant.accounts.some((a) => !available.has(a)))
      changedOrigins.add(origin);
  }
  await updateStore((data) => {
    if (epoch !== startEpoch || !unlocked())
      fail(4100, "Wallet locked during update");
    data.envelope = envelope;
    data.approvals = data.approvals.filter(
      (a) => !changedOrigins.has(a.origin),
    );
  });
  if (epoch !== startEpoch || !unlocked())
    fail(4100, "Wallet locked during update");
  vault = next;
  for (const origin of changedOrigins) {
    const grant = grants[origin];
    if (grant) grant.accounts = grant.accounts.filter((a) => available.has(a));
    originEpochs.set(origin, originEpoch(origin) + 1);
    for (const item of pending.values())
      if (item.origin === origin) rejectPending(item);
  }
  publish();
}
async function ui(
  value: unknown,
  sender: chrome.runtime.MessageSender,
  start = epoch,
) {
  trusted(sender);
  const m = record(value);
  const op = text(m.op, 32);
  switch (op) {
    case "state":
      exact(m, ["kind", "op"]);
      return uiState();
    case "create": {
      exact(m, ["kind", "op", "password", "mnemonic"]);
      if (start !== epoch) fail(4001, "Wallet creation canceled");
      if (Object.hasOwn(stored, "envelope"))
        fail(4100, "A vault already exists");
      const pass = text(m.password),
        next = newVault(
          m.mnemonic === undefined ? undefined : text(m.mnemonic, 512),
        );
      const envelope = await encryptVault(next, pass);
      await updateStore((data) => {
        data.envelope = envelope;
      });
      await activate(next, pass, start);
      return uiState();
    }
    case "unlock": {
      exact(m, ["kind", "op", "password"]);
      if (start !== epoch) fail(4001, "Unlock canceled");
      if (!Object.hasOwn(stored, "envelope"))
        fail(4100, "Create a wallet first");
      if (!isEnvelope(stored.envelope))
        fail(
          4100,
          "Stored vault is damaged or unsupported. Restore it from a backup.",
        );
      const pass = text(m.password);
      const next = await decryptVault(stored.envelope, pass);
      if (start !== epoch) fail(4001, "Unlock canceled");
      await activate(next, pass, start);
      return uiState();
    }
    case "lock":
      exact(m, ["kind", "op"]);
      await lock();
      return uiState();
    case "export": {
      exact(m, ["kind", "op", "password"]);
      requireUnlock();
      const start = epoch;
      if (!isEnvelope(stored.envelope))
        fail(
          4100,
          "Stored vault is damaged or unsupported. Restore it from a backup.",
        );
      const next = await decryptVault(stored.envelope, text(m.password));
      if (epoch !== start || !unlocked()) fail(4100, "Wallet locked");
      return {
        mnemonic: next.mnemonic,
        derivation: next.derivation,
        importedKeys: next.accounts
          .filter((a) => a.index === undefined)
          .map((a) => ({ name: a.name, key: a.key })),
      };
    }
    case "addAccount": {
      exact(m, ["kind", "op", "key"]);
      const next = structuredClone(requireUnlock());
      if (next.accounts.length >= 32) fail(-32602, "Account limit reached");
      let key =
        m.key === undefined
          ? deriveKey(next.mnemonic, next.nextIndex)
          : text(m.key, 66).replace(/^0x/, "").toLowerCase();
      while (m.key === undefined && next.accounts.some((a) => a.key === key)) {
        next.nextIndex++;
        key = deriveKey(next.mnemonic, next.nextIndex);
      }
      if (
        !/^[0-9a-f]{64}$/.test(key) ||
        next.accounts.some((a) => a.key === key)
      )
        fail(-32602, "Invalid or duplicate private key");
      next.accounts.push({
        name:
          m.key === undefined
            ? `Account ${next.nextIndex + 1}`
            : `Imported ${publicAccount({ name: "", key }).address.slice(2, 8)}`,
        key,
        ...(m.key === undefined ? { index: next.nextIndex++ } : {}),
      });
      await saveSecrets(next);
      return uiState();
    }
    case "removeAccount": {
      exact(m, ["kind", "op", "account"]);
      const next = structuredClone(requireUnlock());
      const target = address(m.account);
      next.accounts = next.accounts.filter(
        (a) => publicAccount(a).address !== target,
      );
      await saveSecrets(next);
      return uiState();
    }
    case "network": {
      exact(m, ["kind", "op", "network"]);
      requireUnlock();
      const network = text(m.network) as Network;
      if (!Object.hasOwn(NETWORKS, network)) fail(-32602, "Unknown network");
      invalidate();
      await updateStore((next) => {
        next.approvals = [];
      });
      const hash = hex(
        (await (await clientFor(network)).getNetworkInfo()).networkHash,
      );
      requireUnlock();
      if (network === "localnet" && hash !== "0".repeat(64))
        fail(4901, "Localnet must use the zero network hash");
      await updateStore((next) => {
        next.network = network;
        next.pin = hash;
        next.approvals = [];
      });
      grants = {};
      invalidate();
      return uiState();
    }
    case "revoke":
      exact(m, ["kind", "op", "origin"]);
      requireUnlock();
      await disconnect(text(m.origin));
      return uiState();
    case "portfolio": {
      exact(m, ["kind", "op", "account"]);
      const owner = address(m.account);
      secretFor(owner);
      return portfolio(stored.network, owner, [
        nativeToken,
        ...(stored.tokens[stored.pin] || []),
      ]);
    }
    case "addToken": {
      exact(m, ["kind", "op", "address"]);
      requireUnlock();
      const hash = stored.pin,
        network = stored.network;
      const token = await tokenMetadata(network, address(m.address));
      if (hash !== stored.pin || network !== stored.network)
        fail(4901, "Network changed");
      await updateStore((next) => {
        const tokens = (next.tokens[hash] ||= []);
        if (tokens.length >= 64) fail(-32602, "Token limit reached");
        if (
          token.address !== nativeToken.address &&
          !tokens.some((t) => t.address === token.address)
        )
          tokens.push(token);
      });
      return token;
    }
    case "airdrop": {
      exact(m, ["kind", "op", "account"]);
      const owner = address(m.account);
      secretFor(owner);
      await networkCheck();
      const key = `${stored.pin}:${owner}`,
        network = stored.network;
      const nonce =
        stored.airdrops[key] || hex(crypto.getRandomValues(new Uint8Array(16)));
      await updateStore((next) => {
        next.airdrops[key] = nonce;
      });
      const result = await (
        await clientFor(network)
      ).requestAirdrop({
        recipient: addressFromHex(owner),
        clientNonce: unhex(nonce),
        timeoutMs: 45000,
      });
      await updateStore((next) => {
        delete next.airdrops[key];
      });
      requireAirdropSuccess(result);
      return { hash: toHex0x(result.txHash) };
    }
    case "prepareTransfer": {
      if (stored.recoveryBlocked)
        fail(
          4100,
          "Transfer recovery data is damaged. Follow Manual storage recovery in the wallet README before sending again.",
        );
      exact(m, ["kind", "op", "account", "token", "receiver", "amount"]);
      const secret = secretFor(address(m.account));
      assertTransferAvailable(stored.outgoing, address(m.account), stored.pin);
      const token = [nativeToken, ...(stored.tokens[stored.pin] || [])].find(
        (t) => t.address === address(m.token),
      );
      if (!token) fail(-32602, "Add this token first");
      await networkCheck();
      const transaction = await transferTransaction(
        stored.network,
        secret,
        token,
        address(m.receiver),
        text(m.amount, 100),
      );
      return {
        transaction,
        networkHash: stored.pin,
        review: inspectTransaction(transaction, secret).review,
      };
    }
    case "sendTransfer": {
      if (stored.recoveryBlocked)
        fail(
          4100,
          "Transfer recovery data is damaged. Follow Manual storage recovery in the wallet README before sending again.",
        );
      exact(m, ["kind", "op", "account", "transaction", "networkHash"]);
      const account = address(m.account),
        secret = secretFor(account),
        hash = text(m.networkHash, 64);
      const start = epoch;
      assertTransferAvailable(stored.outgoing, account, hash);
      await networkCheck(hash);
      const signed = await signApproved(
        inspectTransaction(text(m.transaction, MAX_UNSIGNED_HEX), secret).tx,
        secret,
        hash,
      );
      if (epoch !== start || !unlocked()) fail(4100, "Wallet state changed");
      const network = stored.network;
      await updateStore((next) => {
        if (epoch !== start || !unlocked()) fail(4100, "Wallet state changed");
        assertTransferAvailable(next.outgoing, account, hash);
        next.outgoing.push({
          hash: signed.hash,
          account,
          network,
          networkHash: hash,
          outcome: "unknown",
          createdAt: Date.now(),
        });
      });
      refreshUi();
      if (epoch !== start || !unlocked()) fail(4100, "Wallet state changed");
      const client = await clientFor(stored.network);
      if (epoch !== start || !unlocked()) fail(4100, "Wallet state changed");
      try {
        const hash = await client.sendTransaction(
          deserializeSignedTransaction(
            unhex(signed.signedTransaction.slice(2)),
          ),
        );
        if (toHex0x(hash) !== signed.hash)
          throw new Error("Unexpected RPC hash");
      } catch {
        return {
          hash: signed.hash,
          status:
            "Broadcast outcome unknown. Do not send again; inspect this hash",
        };
      }
      await updateStore((next) => {
        const record = next.outgoing.find(
          (r) => r.hash === signed.hash && r.networkHash === hash,
        );
        if (record) record.outcome = "submitted";
      });
      refreshUi();
      try {
        const receipt = await client.waitForTransactionReceipt(
          hashFromHex(signed.hash),
          { timeoutMs: 30000 },
        );
        const ok = receipt.execResult === ExecResult.ExecResultOK;
        await updateStore((next) => {
          const record = next.outgoing.find(
            (r) => r.hash === signed.hash && r.networkHash === hash,
          );
          if (record) record.outcome = ok ? "confirmed" : "failed";
        });
        refreshUi();
        return {
          hash: signed.hash,
          status: ok ? "Confirmed" : "Execution failed",
        };
      } catch (error) {
        const advisory =
          error instanceof Error
            ? error.message.slice(0, 1024)
            : "Receipt unavailable";
        await updateStore((next) => {
          const record = next.outgoing.find(
            (r) => r.hash === signed.hash && r.networkHash === hash,
          );
          if (record) record.advisory = advisory;
        });
        refreshUi();
        return {
          hash: signed.hash,
          status: PENDING_TRANSFER_ADVISORY,
        };
      }
    }
    case "observeTransfer": {
      exact(m, ["kind", "op", "hash", "networkHash"]);
      requireUnlock();
      const hash = address(m.hash),
        networkHash = text(m.networkHash, 64);
      const transfer = stored.outgoing.find(
        (r) => r.hash === hash && r.networkHash === networkHash,
      );
      if (!transfer) fail(-32602, "Unknown outgoing transfer");
      const client = await clientFor(transfer.network);
      if (hex((await client.getNetworkInfo()).networkHash) !== networkHash)
        fail(4901, "Recovery endpoint identity changed");
      const receipt = await client.getTransactionReceipt(hashFromHex(hash));
      if (receipt)
        await updateStore((next) => {
          const record = next.outgoing.find(
            (r) => r.hash === hash && r.networkHash === networkHash,
          );
          if (record)
            record.outcome =
              receipt.execResult === ExecResult.ExecResultOK
                ? "confirmed"
                : "failed";
        });
      refreshUi();
      return uiState();
    }
    case "ackTransfer": {
      exact(m, ["kind", "op", "hash", "networkHash", "confirmRisk"]);
      requireUnlock();
      if (m.confirmRisk !== true)
        fail(-32602, "Explicit acknowledgment required");
      const hash = address(m.hash),
        networkHash = text(m.networkHash, 64);
      await updateStore((next) => {
        next.outgoing = next.outgoing.filter(
          (r) => r.hash !== hash || r.networkHash !== networkHash,
        );
      });
      refreshUi();
      return uiState();
    }
    case "approval": {
      exact(m, ["kind", "op", "id"]);
      const item = pending.get(text(m.id, 36));
      if (!item) fail(4001, "Approval expired or worker restarted");
      await liveDocument(item);
      return {
        id: item.id,
        origin: item.origin,
        method: item.request.method,
        networkHash: item.networkHash,
        account:
          item.request.method === "signTransaction"
            ? item.request.params.account
            : undefined,
        review: item.review,
        accounts: (unlocked() ? vault!.accounts : []).map((s) => ({
          ...publicAccount(s),
          name: s.name,
        })),
      };
    }
    case "decide": {
      exact(m, ["kind", "op", "id", "approve", "accounts"]);
      const item = pending.get(text(m.id, 36));
      if (!item) fail(4001, "Approval expired");
      if (
        sender.tab?.id !== item.approvalTab ||
        new URL(sender.url!).searchParams.get("approval") !== item.id
      )
        fail(4100, "Wrong approval window");
      if (m.approve !== true) {
        rejectPending(item, "User rejected the request");
        return null;
      }
      await liveDocument(item);
      requireUnlock();
      await networkCheck(item.networkHash);
      await liveDocument(item);
      let result: unknown;
      if (item.request.method === "connect") {
        if (
          !Array.isArray(m.accounts) ||
          !m.accounts.length ||
          m.accounts.length > 32
        )
          fail(-32602, "Select at least one account");
        const selected = new Set(
          m.accounts.map((a) => {
            const value = address(a);
            secretFor(value);
            return value;
          }),
        );
        const accounts = requireUnlock()
          .accounts.map((a) => publicAccount(a).address)
          .filter((a) => selected.has(a));
        const grant = { networkHash: item.networkHash, accounts };
        item.granting = true;
        const changed =
          JSON.stringify(
            session(item.origin).accounts.map((a) => a.address),
          ) !== JSON.stringify(accounts);
        if (changed) {
          originEpochs.set(item.origin, originEpoch(item.origin) + 1);
          item.originEpoch = originEpoch(item.origin);
        }
        try {
          await updateStore((next) => {
            if (
              !pending.has(item.id) ||
              item.epoch !== epoch ||
              item.originEpoch !== originEpoch(item.origin)
            )
              fail(4001, "Approval expired");
            if (changed)
              next.approvals = next.approvals.filter(
                (a) => a.origin !== item.origin,
              );
          });
          await liveDocument(item);
          requireUnlock();
          grants[item.origin] = grant;
          revoked.delete(item.origin);
          await publish();
          await liveDocument(item);
          requireUnlock();
          result = session(item.origin);
        } catch (error) {
          // Suppress authority synchronously, before fallible cleanup. Grants
          // are worker-local, so neither stale disk data nor restart revives it.
          rejectPending(item, "Connection approval failed");
          await publish();
          await updateStore((next) => {
            next.approvals = next.approvals.filter(
              (a) => a.origin !== item.origin,
            );
          });
          throw error;
        }
      } else if (item.request.method === "signTransaction") {
        const p = item.request.params;
        assertGrant(item.origin, p.account, p.networkHash);
        const secret = secretFor(p.account);
        result = await signApproved(
          inspectTransaction(p.transaction, secret).tx,
          secret,
          p.networkHash,
        );
        await liveDocument(item);
        requireUnlock();
        const approval = {
          origin: item.origin,
          account: p.account,
          networkHash: p.networkHash,
          ...(result as { signedTransaction: string; hash: string }),
        };
        try {
          await updateStore((next) => {
            if (
              !pending.has(item.id) ||
              item.epoch !== epoch ||
              item.originEpoch !== originEpoch(item.origin)
            )
              fail(4001, "Approval expired");
            assertGrant(item.origin, p.account, p.networkHash);
            next.approvals = replaceApproval(next.approvals, approval);
          });
          await liveDocument(item);
          assertGrant(item.origin, p.account, p.networkHash);
          eligible.set(approvalScope(approval), approval.hash);
        } catch (error) {
          // Cleanup can fail without granting authority or restoring the prior
          // approval. A valid new attempt retired that scope during preflight.
          eligible.delete(approvalScope(approval));
          rejectPending(item, "Signing approval failed");
          await updateStore((next) => {
            next.approvals = next.approvals.filter(
              (a) => approvalScope(a) !== approvalScope(approval),
            );
          }).catch(() => {});
          throw error;
        }
      } else fail(4200, "Unsupported approval");
      pending.delete(item.id);
      clearTimeout(item.timer);
      refreshUi();
      item.resolve(result);
      return { approved: true };
    }
    default:
      fail(4200, "Unsupported wallet operation");
  }
}
let uiQueue: Promise<unknown> = Promise.resolve();
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  const task = async () => {
    await ready;
    const m = record(message);
    if (m.kind === "provider") {
      exact(m, ["kind", "id", "request"]);
      return provider(m.request, text(m.id, 36), sender);
    }
    if (m.kind === "cancel") {
      pageOrigin(sender);
      for (const item of pending.values())
        if (
          item.sender.documentId === sender.documentId &&
          item.requestId === m.id
        )
          rejectPending(item);
      return null;
    }
    if (m.kind === "ui") {
      trusted(sender);
      // Lock must preempt slow encryption and network operations.
      if (m.op === "lock" || m.op === "state" || m.op === "approval")
        return ui(m, sender);
      const start = epoch;
      const next = uiQueue.then(() => ui(m, sender, start));
      uiQueue = next.catch(() => {});
      return next;
    }
    fail(4200, "Unsupported message");
  };
  task().then(
    (result) => respond({ result }),
    (error) =>
      respond({
        error: {
          code: error instanceof WalletError ? error.code : -32603,
          message:
            error instanceof Error ? error.message : "Wallet operation failed",
        },
      }),
  );
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "lock")
    void ready
      .then(() => {
        if (vault && expires > 0 && Date.now() >= expires) return lock();
      })
      .catch(() => {});
});
chrome.windows.onRemoved.addListener((id) => {
  for (const item of pending.values())
    if (item.windowId === id) rejectPending(item, "Approval window closed");
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    for (const item of pending.values())
      if (
        item.approvalTab === details.tabId &&
        details.url !== chrome.runtime.getURL(`index.html?approval=${item.id}`)
      )
        rejectPending(item, "Approval window navigated");
      else if (
        item.sender.tab?.id === details.tabId &&
        item.sender.documentId !== details.documentId
      )
        rejectPending(item, "Page navigated");
    for (const [id, sender] of documents)
      if (sender.tab?.id === details.tabId && id !== details.documentId) {
        documents.delete(id);
        snapshots.delete(id);
      }
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  for (const item of pending.values())
    if (item.sender.tab?.id === id || item.approvalTab === id)
      rejectPending(item, "Page closed");
});
