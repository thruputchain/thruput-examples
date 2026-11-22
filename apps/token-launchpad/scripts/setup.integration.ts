import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { test } from "node:test";
import { isThruputError, toBase58 } from "@thruputchain/client";
import {
  inspectRun,
  reconcileRun,
  withLocalScenario,
} from "@thruputchain/testkit";
import { provisionLaunchpad } from "./index";

test(
  "publishes verified local/devnet setup and recovers a lost transaction response",
  { timeout: 180_000 },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "launchpad-testkit-"));
    try {
      await withLocalScenario(
        { seed: "launchpad-setup", accounts: {} },
        async (node) => {
          const output = join(parent, ".env.local");
          const options = {
            network: "local" as const,
            rpcUrl: node.local.rpcUrl,
            output,
            publicDirectory: join(parent, "public"),
          };
          const first = await provisionLaunchpad(options);
          // Both setup modes use the same flow. This tests devnet mode on an isolated local node.
          const current = await provisionLaunchpad({
            ...options,
            network: "devnet",
            networkId: toBase58(node.client.network.networkHash),
          });
          assert.notEqual(toBase58(current.address), toBase58(first.address));
          const published = await readFile(output, "utf8");
          const environment = parseEnv(published);
          assert.equal(
            environment.VITE_STANDARD_TOKEN_FACTORY_ADDRESS,
            toBase58(current.address),
          );
          assert.equal((await stat(output)).mode & 0o777, 0o600);
          // The token code asset is published under its hash.
          const asset = JSON.parse(
            await readFile(
              join(
                parent,
                "public",
                "contract-artifacts",
                `${environment.VITE_STANDARD_TOKEN_HASH}.json`,
              ),
              "utf8",
            ),
          );
          assert.equal(asset.hash, environment.VITE_STANDARD_TOKEN_HASH);

          const runs = join(parent, ".local", "launchpad-setup");
          const names = await readdir(runs);
          assert.equal(names.length, 2);
          for (const name of names) {
            const directory = join(runs, name);
            const report = await inspectRun(join(directory, "transactions"));
            assert.deepEqual(
              report.steps.map(({ name, state }) => `${name}:${state}`),
              [
                "fund-deployer:completed",
                "fund-native-reserve:completed",
                "deploy-factory:completed",
                "verify-factory:completed",
              ],
            );
            assert.deepEqual(
              report.attempts.map((attempt) => attempt.operation),
              ["fund", "call", "deploy"],
            );
            for (const attempt of report.attempts) {
              assert.equal(attempt.outcome, "succeeded");
              assert.ok(attempt.transactionHash);
            }
            const key = JSON.parse(
              await readFile(join(directory, "key.json"), "utf8"),
            );
            assert.equal(report.actors["Launchpad Deployer"], key.address);
            assert.equal(
              (await stat(join(directory, "key.json"))).mode & 0o777,
              0o600,
            );
            assert.ok(!JSON.stringify(report).includes(key.seed));
            assert.ok(!published.includes(key.seed));
            // Signed transactions are private too.
            const evidence = join(directory, "transactions", "evidence");
            assert.equal((await stat(evidence)).mode & 0o777, 0o700);
            for (const file of await readdir(evidence))
              assert.equal(
                (await stat(join(evidence, file))).mode & 0o777,
                0o600,
              );
          }
          await assert.rejects(
            provisionLaunchpad({
              ...options,
              networkId: toBase58(new Uint8Array(32).fill(9)),
            }),
            (error) =>
              isThruputError(error, "rpcIncompatible") &&
              error.context.kind === "network",
          );
          assert.equal(await readFile(output, "utf8"), published);
          assert.equal((await readdir(runs)).length, 2);

          // Drop the response to every signed transaction: the native-token
          // reserve and the factory deployment.
          let sends = 0;
          const proxy = createServer(async (request, response) => {
            try {
              const chunks: Buffer[] = [];
              for await (const chunk of request)
                chunks.push(Buffer.from(chunk));
              const body = Buffer.concat(chunks).toString();
              const upstream = await fetch(node.local.rpcUrl, {
                method: "POST",
                body,
                headers: { "content-type": "application/json" },
              });
              const result = await upstream.text();
              if (JSON.parse(body).method === "sendTransaction") {
                sends++;
                response.destroy();
              } else {
                response.writeHead(upstream.status, {
                  "content-type": "application/json",
                });
                response.end(result);
              }
            } catch (error) {
              response.destroy(error instanceof Error ? error : undefined);
            }
          });
          await new Promise<void>((resolve) =>
            proxy.listen(0, "127.0.0.1", resolve),
          );
          try {
            const address = proxy.address();
            assert.ok(address && typeof address !== "string");
            // Setup observes each signed transaction instead of sending it again.
            await provisionLaunchpad({
              ...options,
              rpcUrl: `http://127.0.0.1:${address.port}`,
            });
            assert.notEqual(await readFile(output, "utf8"), published);
            assert.equal(sends, 2);
            const run = (await readdir(runs)).find(
              (name) => !names.includes(name),
            )!;
            const directory = join(runs, run, "transactions");
            const report = await inspectRun(directory);
            assert.equal(report.steps.at(-1)?.name, "verify-factory");
            assert.equal(report.steps.at(-1)?.state, "completed");
            assert.deepEqual(
              report.attempts.map(({ operation, outcome }) => [
                operation,
                outcome,
              ]),
              [
                ["fund", "succeeded"],
                ["call", "succeeded"],
                ["deploy", "succeeded"],
              ],
            );
            const result = await reconcileRun(directory, node.client);
            assert.deepEqual(
              result.observations.map(({ transactionHash, outcome }) => [
                transactionHash,
                outcome,
              ]),
              report.attempts.map(({ transactionHash }) => [
                transactionHash,
                "succeeded",
              ]),
            );
            assert.equal(sends, 2);
            assert.deepEqual(await inspectRun(directory), report);
          } finally {
            proxy.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
              proxy.close((error) => (error ? reject(error) : resolve())),
            );
          }
        },
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
