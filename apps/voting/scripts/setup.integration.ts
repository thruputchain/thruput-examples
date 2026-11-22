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
import { parseConfig } from "../src/config";
import { Voting } from "../src/contracts/generated/voting";
import { provisionVoting } from "./index";

test(
  "publishes verified local/devnet setup, retains its client, and recovers a lost deployment response",
  { timeout: 180_000 },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "voting-testkit-"));
    try {
      await withLocalScenario(
        { seed: "voting-setup", accounts: {} },
        async (node) => {
          const output = join(parent, ".env.local");
          const options = {
            network: "local" as const,
            rpcUrl: node.local.rpcUrl,
            output,
          };
          const first = await provisionVoting(options);
          // Exercise devnet mode against an isolated local node, not the hosted endpoint.
          const current = await provisionVoting({
            ...options,
            network: "devnet",
            networkId: toBase58(node.client.network.networkHash),
          });
          assert.notEqual(toBase58(current.address), toBase58(first.address));
          // The returned external client must remain usable after the scenario closes.
          assert.equal(
            (
              await Voting.v0_1.count.view({
                client: current.client,
                address: current.address,
              })
            ).value,
            0n,
          );
          const published = await readFile(output, "utf8");
          const config = parseConfig(parseEnv(published));
          assert.equal(toBase58(config.address), toBase58(current.address));
          assert.equal((await stat(output)).mode & 0o777, 0o600);
          const runs = join(parent, ".local", "voting-setup");
          const names = await readdir(runs);
          assert.equal(names.length, 2);
          for (const name of names) {
            const directory = join(runs, name);
            const report = await inspectRun(join(directory, "transactions"));
            assert.ok(report.steps.every((step) => step.state === "completed"));
            assert.equal(report.steps.at(-1)?.name, "verify-voting");
            // Faucet funding and deployment are both recorded with hashes.
            assert.deepEqual(
              report.attempts.map((attempt) => attempt.operation),
              ["fund", "deploy"],
            );
            for (const attempt of report.attempts) {
              assert.equal(attempt.outcome, "succeeded");
              assert.ok(attempt.transactionHash);
            }
            const key = JSON.parse(
              await readFile(join(directory, "key.json"), "utf8"),
            );
            assert.equal(report.actors["Voting Deployer"], key.address);
            assert.equal(
              (await stat(join(directory, "key.json"))).mode & 0o777,
              0o600,
            );
            assert.ok(!JSON.stringify(report).includes(key.seed));
            assert.ok(!published.includes(key.seed));
          }
          await assert.rejects(
            provisionVoting({
              ...options,
              networkId: toBase58(new Uint8Array(32).fill(9)),
            }),
            (error) =>
              isThruputError(error, "rpcIncompatible") &&
              error.context.kind === "network",
          );
          assert.equal(await readFile(output, "utf8"), published);
          assert.equal((await readdir(runs)).length, 2);

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
            // The deployment's send response is lost. Setup observes the signed
            // transaction instead of sending it again, then finishes.
            await provisionVoting({
              ...options,
              rpcUrl: `http://127.0.0.1:${address.port}`,
            });
            assert.notEqual(await readFile(output, "utf8"), published);
            assert.equal(sends, 1);
            const run = (await readdir(runs)).find(
              (name) => !names.includes(name),
            )!;
            const directory = join(runs, run, "transactions");
            const report = await inspectRun(directory);
            assert.equal(report.steps.at(-1)?.state, "completed");
            const [funding, attempt] = report.attempts;
            assert.ok(funding && attempt);
            assert.equal(funding.outcome, "succeeded");
            assert.equal(attempt.operation, "deploy");
            assert.equal(attempt.outcome, "succeeded");
            assert.ok(attempt.transactionHash);
            const result = await reconcileRun(directory, node.client);
            // The faucet hash is observed by hash; the deployment by its signed evidence.
            const [fundingObservation, observation] = result.observations;
            assert.ok(fundingObservation && observation);
            assert.equal(fundingObservation.outcome, "succeeded");
            assert.equal(
              fundingObservation.transactionHash,
              funding.transactionHash,
            );
            assert.ok(fundingObservation.receipt);
            assert.equal(observation.outcome, "succeeded");
            assert.equal(observation.transactionHash, attempt.transactionHash);
            assert.equal(sends, 1);
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
