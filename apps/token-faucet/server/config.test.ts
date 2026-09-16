import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readManifest } from "./config";

const deployment = fileURLToPath(
  new URL("../deployments/devnet.json", import.meta.url),
);

it("loads five tokens and the existing hosted Swap link without pool configuration", async () => {
  const manifest = await readManifest(deployment);
  expect(manifest.tokens).toHaveLength(5);
  expect(manifest.swapUrl).toBe(
    "https://swap-production-66df.up.railway.app/pools",
  );
  expect(manifest).not.toHaveProperty("factory");
  expect(manifest).not.toHaveProperty("router");
  expect(manifest).not.toHaveProperty("pools");
});

it("allows a validated runtime Swap URL override", async () => {
  expect(
    (await readManifest(deployment, "https://swap.example.test/pools")).swapUrl,
  ).toBe("https://swap.example.test/pools");
  await expect(readManifest(deployment, "javascript:alert(1)")).rejects.toThrow(
    "Invalid swapUrl",
  );
});
