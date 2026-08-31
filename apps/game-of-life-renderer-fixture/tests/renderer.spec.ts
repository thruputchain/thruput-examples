import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => "fixture" in window);
});

test("uploads and samples unsigned 16-bit integer textures exactly", async ({
  page,
}) => {
  const result = await page.evaluate(() =>
    window.fixture.runIntegerTextureProbe(),
  );
  expect(result.error).toBe(0);
  expect(result.pixels).toEqual([1, 2, 0, 255, 255, 15, 0, 255]);
  expect(result.renderer.length).toBeGreaterThan(0);
});

test("decodes, uploads, picks, and releases zoom-six exact-cell tiles", async ({
  page,
}) => {
  const result = await page.evaluate(() => window.fixture.runExactCellProbe());
  expect(result.errors).toEqual([]);
  expect(result.zooms).toEqual([6, 6]);
  expect(result.values).toEqual([1, 0]);
  expect(result.byteLength).toBe(73_728);
  expect(result.packedByteLength).toBe(8_192);
  expect(result.decodedByteLength).toBe(65_536);
  expect(result.pixels[0]).toEqual([255, 217, 230, 255]);
  expect(result.pixels[1]).toEqual([0, 38, 89, 255]);
  expect(result.resourcesCreated).toBeGreaterThan(0);
  expect(result.resourcesDestroyed).toBe(result.resourcesCreated);
});

test("keeps digest layers isolated and cleans up tile work", async ({
  page,
}) => {
  const result = await page.evaluate(() =>
    window.fixture.runDeckLifecycleProbe(),
  );
  expect(result.loadedDigests).toEqual(["new", "old"]);
  expect(result.requested).toContain("new:0/0/0");
  expect(result.requested).toContain("old:0/0/0");
  expect(result.requested).toContain("delayed:0/0/0");
  expect(result.pickedDigest).toBe("new");
  expect(result.outsideWorldPicked).toBe(false);
  expect(result.pickedTexel).not.toBeNull();
  const x = result.pickedTexel![0]!;
  const y = result.pickedTexel![1]!;
  expect(result.pickedCoveredCells).toBe(4_096);
  expect(result.pickedValue).toBe((y * 256 + x) % 4_097);
  const density = result.pickedValue! / result.pickedCoveredCells!;
  expect(result.renderedPixel[0]).toBeCloseTo(density * 255, 0);
  expect(result.renderedPixel[1]).toBeCloseTo((0.15 + density * 0.7) * 255, 0);
  expect(result.renderedPixel[2]).toBeCloseTo((0.35 + density * 0.55) * 255, 0);
  expect(result.renderedPixel[3]).toBe(255);
  expect(result.refinementCalls).toBeGreaterThan(0);
  expect(result.errors).toEqual([]);
  expect(result.finalized).toBeGreaterThanOrEqual(2);
  expect(result.aborted).toBeGreaterThanOrEqual(1);
  expect(result.resourcesCreated).toBeGreaterThanOrEqual(4);
  expect(result.resourcesDestroyed).toBe(result.resourcesCreated);
  expect(result.tileUnloads).toBeGreaterThan(0);
  expect(result.evictionResourceDestructions).toBeGreaterThan(0);
});

test("normalizes and clips the partial world-edge texel", async ({ page }) => {
  const result = await page.evaluate(() =>
    window.fixture.runClippedEdgeProbe(),
  );
  expect(result.errors).toEqual([]);
  expect(result.coveredCells).toBe(256);
  const density = result.value / result.coveredCells;
  expect(result.insidePixel[0]).toBeCloseTo(density * 255, 0);
  expect(result.insidePixel[1]).toBeCloseTo((0.15 + density * 0.7) * 255, 0);
  expect(result.insidePixel[2]).toBeCloseTo((0.35 + density * 0.55) * 255, 0);
  expect(result.insidePixel[3]).toBe(255);
  expect(result.outsidePixel).toEqual([0, 0, 0, 0]);
});

test("clamps orthographic controller interaction to the real world", async ({
  page,
}) => {
  await page.evaluate(() => window.fixture.setupControllerProbe());
  const canvas = page.locator("#fixture");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const centerX = bounds!.x + bounds!.width / 2;
  const centerY = bounds!.y + bounds!.height / 2;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width - 1, centerY, { steps: 4 });
    await page.mouse.up();
  }
  const minimum = await page.evaluate(() =>
    window.fixture.getControllerTarget(),
  );
  expect(minimum[0]).not.toBe(5_000);
  expect(minimum[0]).toBeCloseTo(256, 0);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + 1, centerY, { steps: 4 });
    await page.mouse.up();
  }
  const maximum = await page.evaluate(() =>
    window.fixture.getControllerTarget(),
  );
  expect(maximum[0]).toBeCloseTo(9_744, 0);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX, bounds!.y + bounds!.height - 1, {
      steps: 4,
    });
    await page.mouse.up();
  }
  const verticalMinimum = await page.evaluate(() =>
    window.fixture.getControllerTarget(),
  );
  expect(verticalMinimum[1]).not.toBe(5_000);
  expect(verticalMinimum[1]).toBeCloseTo(256, 0);

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX, bounds!.y + 1, { steps: 4 });
    await page.mouse.up();
  }
  const verticalMaximum = await page.evaluate(() =>
    window.fixture.getControllerTarget(),
  );
  expect(verticalMaximum[1]).toBeCloseTo(9_744, 0);
  await page.evaluate(() => window.fixture.finalizeControllerProbe());
});
