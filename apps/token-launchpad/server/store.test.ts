// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TokenStore, type IndexedToken } from "./store";

let directory: string;
let store: TokenStore;
const scope = { networkId: "network", factoryAddress: "factory" };
const token = (n: number, creator = "alice"): IndexedToken => ({
  address: `token-${n}`,
  creator,
  name: `Token ${n}`,
  symbol: `T${n}`,
  decimals: 6,
  initialSupply: "1000",
  blockHeight: String(n),
  transactionHash: `tx-${n}`,
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "launchpad-store-"));
  store = new TokenStore(join(directory, "tokens.sqlite"), scope);
});
afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true });
});

it("saves each event once, newest first, and pages through them", () => {
  for (const n of [1, 2, 3]) store.saveToken(token(n), 0);
  // Replaying a block saves the same event identity again.
  store.saveToken(token(3), 0);
  const first = store.listTokens({ limit: 2, offset: 0 });
  expect(first.tokens.map((t) => t.address)).toEqual(["token-3", "token-2"]);
  expect(first.hasMore).toBe(true);
  expect(store.listTokens({ limit: 2, offset: 2 }).tokens).toHaveLength(1);
});

it("searches by name, symbol, or address, and filters by creator", () => {
  store.saveToken(token(1, "alice"), 0);
  store.saveToken(token(2, "bob"), 0);
  const ids = (query: Parameters<TokenStore["listTokens"]>[0]) =>
    store.listTokens(query).tokens.map((t) => t.address);
  expect(ids({ q: "T2", limit: 10, offset: 0 })).toEqual(["token-2"]);
  expect(ids({ q: "token-1", limit: 10, offset: 0 })).toEqual(["token-1"]);
  expect(ids({ creator: "alice", limit: 10, offset: 0 })).toEqual(["token-1"]);
});

it("keeps the checkpoint", () => {
  expect(store.loadCheckpoint()).toBeUndefined();
  store.saveCheckpoint(42n);
  expect(store.loadCheckpoint()).toBe(42n);
});

it("matches % and _ in a search literally", () => {
  store.saveToken(token(1), 0);
  store.saveToken({ ...token(2), name: "100% Token", symbol: "P_C" }, 0);
  const ids = (q: string) =>
    store.listTokens({ q, limit: 10, offset: 0 }).tokens.map((t) => t.address);
  expect(ids("_")).toEqual(["token-2"]);
  expect(ids("%")).toEqual(["token-2"]);
});

it("refuses a database written by the previous Launchpad", () => {
  const path = join(directory, "previous.sqlite");
  const previous = new DatabaseSync(path);
  previous.exec("CREATE TABLE registry_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  previous.close();
  expect(() => new TokenStore(path, scope)).toThrow(/earlier version of Launchpad/);
});

it("refuses a database that indexes another factory", () => {
  const path = join(directory, "tokens.sqlite");
  expect(
    () => new TokenStore(path, { ...scope, factoryAddress: "other factory" }),
  ).toThrow(/indexes factory factory on network network/);
  // The same deployment opens it again.
  new TokenStore(path, scope).close();
});

it("pins a listing to a block, so new tokens do not shift later pages", () => {
  for (const n of [1, 2, 3]) store.saveToken(token(n), 0);
  store.saveCheckpoint(3n);
  const first = store.listTokens({ limit: 2, offset: 0 });
  expect(first.asOfBlock).toBe("3");
  expect(first.tokens.map((t) => t.address)).toEqual(["token-3", "token-2"]);
  // A token launched after the first page was read.
  store.saveToken(token(4), 0);
  store.saveCheckpoint(4n);
  const second = store.listTokens({ limit: 2, offset: 2, asOfBlock: 3 });
  expect(second.tokens.map((t) => t.address)).toEqual(["token-1"]);
  expect(store.listTokens({ limit: 2, offset: 0 }).tokens[0]!.address).toBe("token-4");
});

it("lists only fully indexed blocks, so a block split across RPC pages cannot shift a page", () => {
  for (const n of [1, 2]) store.saveToken(token(n), 0);
  store.saveCheckpoint(2n);
  // Part of block 3 arrived; the rest comes with the next RPC page.
  store.saveToken(token(3), 0);
  const page = store.listTokens({ limit: 10, offset: 0 });
  expect(page.asOfBlock).toBe("2");
  expect(page.tokens.map((t) => t.address)).toEqual(["token-2", "token-1"]);
});
