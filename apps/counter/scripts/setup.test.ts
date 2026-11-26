import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addressFromBase58,
  createThruputClient,
  HttpTransport,
  localnet,
  MockTransport,
  toBase58,
  toHex0x,
  type RpcParams,
  type TransportRequestOptions,
} from "@thruputchain/client";
import { CxsWriter } from "@thruputchain/xdr";
import { inspectRun, loadKeyFile, reconcileRun } from "@thruputchain/testkit";
import { loadServerConfig } from "../server/config";
import { provisionCounter, setup } from "./index";

let directory: string;
let options: Parameters<typeof provisionCounter>[0];
let mock: MockTransport;
let fail:
  | "funding"
  | "deployment"
  | "lostResponse"
  | "verification"
  | "report"
  | undefined;
let sends: number;

async function readRun() {
  const parent = join(directory, ".local", "counter-setup");
  const names = (await readdir(parent)).sort();
  const runDirectory = join(parent, names.at(-1)!);
  return {
    runDirectory,
    report: await inspectRun(join(runDirectory, "transactions")),
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "counter-setup-"));
  options = {
    network: "local",
    rpcUrl: "http://127.0.0.1:9545",
    output: join(directory, ".env.local"),
    artifact: join(directory, "counter.rv32a"),
  };
  await writeFile(options.artifact!, "counter artifact");
  mock = new MockTransport();
  fail = undefined;
  sends = 0;
  vi.spyOn(HttpTransport.prototype, "request").mockImplementation(
    async <T>(
      method: string,
      params?: RpcParams,
      control?: TransportRequestOptions,
    ): Promise<T> => {
      if (method === "faucet_requestAirdrop" && fail === "funding")
        throw new Error("Funding stopped");
      const result = await mock.request<T>(method, params, control);
      if (method === "sendTransaction") {
        sends++;
        if (fail === "lostResponse")
          throw new Error("Response lost after submission");
      }
      // Every receipt returns the predicted Counter address, read from the
      // deployment step. Only the deployment decodes it; other receipts ignore it.
      if (method === "getTransactionReceipt" && result) {
        const { report } = await readRun();
        const address = report.steps.find(
          (step) => step.name === "deploy-counter",
        )?.metadata?.address;
        if (typeof address !== "string")
          throw new Error("Missing deployment intent");
        return {
          ...(result as object),
          execution:
            fail === "deployment"
              ? { result: "abort", abortData: "0x00" }
              : {
                  result: "return",
                  returnData: toHex0x(addressFromBase58(address)),
                },
        } as T;
      }
      if (method === "simulateInvocations") {
        if (fail === "report") {
          const { runDirectory } = await readRun();
          const path = join(runDirectory, "transactions", "report.json");
          await rm(path);
          await mkdir(path); // A completed-step report cannot replace a directory.
        }
        const writer = new CxsWriter();
        writer.writeUint64(fail === "verification" ? 0n : 1_000_000n);
        return {
          ...(result as object),
          results: [
            {
              output: {
                result: "return",
                returnData: toHex0x(writer.finish()),
              },
              events: [],
              gasUsed: "0",
            },
          ],
        } as T;
      }
      return result;
    },
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it("publishes fresh accounts after verified deployment and preserves public report/private key separation", async () => {
  await provisionCounter(options);
  const first = loadServerConfig(
    parseEnv(await readFile(options.output, "utf8")),
  ).app;
  await provisionCounter(options);
  const environment = await readFile(options.output, "utf8");
  const second = loadServerConfig(parseEnv(environment)).app;
  expect(second.counterAddress).not.toBe(first.counterAddress);
  expect(second.signerAddress).not.toBe(first.signerAddress);
  expect((await stat(options.output)).mode & 0o777).toBe(0o600);
  const { runDirectory, report } = await readRun();
  expect(report.actors).toEqual({ "Counter Operator": second.signerAddress });
  expect(report.steps.map(({ name, state }) => ({ name, state }))).toEqual([
    { name: "fund-operator", state: "completed" },
    { name: "deploy-counter", state: "completed" },
    { name: "verify-counter", state: "completed" },
  ]);
  expect(report.steps[1]?.metadata).toEqual({
    address: second.counterAddress,
    initialValue: "1000000",
  });
  // Faucet funding and deployment are both recorded with their hashes.
  expect(
    report.attempts.map(({ actor, operation, step, outcome, state }) => ({
      actor,
      operation,
      step,
      outcome,
      state,
    })),
  ).toEqual(
    ["fund", "deploy"].map((operation, index) => ({
      actor: "Counter Operator",
      operation,
      step: index === 0 ? "fund-operator" : "deploy-counter",
      outcome: "succeeded",
      state: "committed",
    })),
  );
  expect(report.attempts.every((attempt) => attempt.transactionHash)).toBe(
    true,
  );
  const calls = vi.mocked(HttpTransport.prototype.request).mock.calls;
  expect(
    calls.filter(([method]) => method === "simulateInvocations").at(-1)?.[1],
  ).toMatchObject({ minStateBlockHeight: "2" });
  const key = JSON.parse(
    await readFile(join(runDirectory, "key.json"), "utf8"),
  );
  // The saved key restores the signer published to the app.
  expect((await loadKeyFile(join(runDirectory, "key.json"))).address).toBe(
    second.signerAddress,
  );
  expect(parseEnv(environment).COUNTER_SIGNING_PRIVATE_KEY).toBe(key.seed);
  expect(JSON.stringify(report)).not.toContain(key.seed);
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
    key.seed,
  );
  expect((await stat(join(runDirectory, "key.json"))).mode & 0o777).toBe(0o600);
  expect((await readdir(runDirectory)).sort()).toEqual([
    "key.json",
    "transactions",
  ]);
});

it.each(["funding", "deployment", "verification", "report"] as const)(
  "preserves the previous environment when %s fails",
  async (phase) => {
    fail = phase;
    await writeFile(options.output, "previous environment");
    // Each phase stops setup for its own reason.
    const reasons = {
      funding: { code: "fundingStopped" },
      deployment: { code: "transactionFailed" },
      verification: { message: expect.stringContaining("verification failed") },
      report: { code: "EISDIR" },
    };
    await expect(provisionCounter(options)).rejects.toMatchObject(
      reasons[phase],
    );
    expect(await readFile(options.output, "utf8")).toBe("previous environment");
    expect((await readdir(directory)).sort()).toEqual([
      ".env.local",
      ".local",
      "counter.rv32a",
    ]);
    if (phase !== "report") {
      const { report } = await readRun();
      expect(report.steps.at(-1)?.state).toBe("failed");
      expect(report.attempts).toHaveLength(phase === "funding" ? 1 : 2);
      if (phase === "funding")
        expect(report.attempts[0]).toMatchObject({
          operation: "fund",
          stopped: true,
          outcome: "unknown",
        });
      if (phase === "deployment")
        expect(report.attempts[1]?.outcome).toBe("failed");
      if (phase === "verification")
        expect(report.attempts[1]?.outcome).toBe("succeeded");
    }
  },
);

it("observes the original deployment after a lost response without resending", async () => {
  fail = "lostResponse";
  await provisionCounter(options);
  const { runDirectory, report } = await readRun();
  const deployment = report.attempts[1];
  expect(deployment?.outcome).toBe("succeeded");
  expect(deployment?.transactionHash).toBeTruthy();
  const client = await createThruputClient({
    cluster: localnet(),
    transport: mock,
  });
  const result = await reconcileRun(join(runDirectory, "transactions"), client);
  expect(result.observations[1]).toMatchObject({
    transactionHash: deployment?.transactionHash,
    outcome: "succeeded",
  });
  expect(sends).toBe(1);
  expect(await inspectRun(join(runDirectory, "transactions"))).toEqual(report);
});

it("keeps verified evidence when environment publication fails and removes the temporary file", async () => {
  await mkdir(options.output);
  await expect(provisionCounter(options)).rejects.toThrow();
  const { report } = await readRun();
  expect(report.steps.at(-1)).toMatchObject({
    name: "verify-counter",
    state: "completed",
  });
  expect(report.attempts.map(({ outcome }) => outcome)).toEqual([
    "succeeded",
    "succeeded",
  ]);
  expect((await stat(options.output)).isDirectory()).toBe(true);
  expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(
    false,
  );
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
    "Counter ready",
  );
});

it("rejects a network change between discovery and scenario connection before funding", async () => {
  const request = vi
    .mocked(HttpTransport.prototype.request)
    .getMockImplementation()!;
  let networkReads = 0;
  vi.mocked(HttpTransport.prototype.request).mockImplementation(
    async <T>(
      method: string,
      params?: RpcParams,
      control?: TransportRequestOptions,
    ): Promise<T> => {
      if (method === "getNetworkInfo" && ++networkReads > 1) {
        return { networkHash: toBase58(new Uint8Array(32).fill(1)) } as T;
      }
      return (await request(method, params, control)) as T;
    },
  );
  await writeFile(options.output, "previous environment");
  await expect(provisionCounter(options)).rejects.toThrow();
  expect(await readFile(options.output, "utf8")).toBe("previous environment");
  expect(
    vi
      .mocked(HttpTransport.prototype.request)
      .mock.calls.some(([method]) => method === "faucet_requestAirdrop"),
  ).toBe(false);
  expect(sends).toBe(0);
});

it.each(["local", "devnet"] as const)(
  "preserves discovery for %s and validates explicit pins before funding",
  async (network) => {
    const env = {
      COUNTER_APP_ENV: options.output,
      COUNTER_ARTIFACT: options.artifact,
    };
    await setup(env, network);
    expect((await readRun()).report.networkHash).toBe(
      toBase58(new Uint8Array(32)),
    );
    // Each network has its own default RPC URL, and THRUPUT_RPC_URL overrides it.
    const defaultUrl =
      network === "local"
        ? "http://127.0.0.1:9545"
        : "https://rpc.thruput.network";
    expect(await readFile(options.output, "utf8")).toContain(
      `VITE_THRUPUT_RPC_URL=${defaultUrl}\n`,
    );
    await setup({ ...env, THRUPUT_RPC_URL: "http://127.0.0.1:9999" }, network);
    expect(await readFile(options.output, "utf8")).toContain(
      "VITE_THRUPUT_RPC_URL=http://127.0.0.1:9999\n",
    );
    vi.mocked(HttpTransport.prototype.request).mockClear();
    await expect(
      setup(
        { ...env, THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(1)) },
        network,
      ),
    ).rejects.toThrow();
    expect(
      vi
        .mocked(HttpTransport.prototype.request)
        .mock.calls.some(([method]) => method === "faucet_requestAirdrop"),
    ).toBe(false);
  },
);

it("accepts an optional manifest pin and rejects conflicting network inputs", async () => {
  const path = join(directory, "manifest.json");
  const networkHash = toBase58(new Uint8Array(32));
  await writeFile(path, JSON.stringify({ networkHash }));
  const env = {
    COUNTER_APP_ENV: options.output,
    COUNTER_ARTIFACT: options.artifact,
    THRUPUT_RUNTIME_MANIFEST: path,
  };
  await setup(env);
  vi.mocked(HttpTransport.prototype.request).mockClear();
  await expect(
    setup({ ...env, THRUPUT_NETWORK_ID: toBase58(new Uint8Array(32).fill(1)) }),
  ).rejects.toThrow("disagree");
  expect(HttpTransport.prototype.request).not.toHaveBeenCalled();
});
