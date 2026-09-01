import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";

test("advances, indexes, visualizes, and recovers one complete world", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const navigationStarted = performance.now();

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Life Observatory" }),
  ).toBeVisible();
  const firstContentMs = performance.now() - navigationStarted;
  const initialReady = page.getByText(/Ready · generation \d+/);
  await expect(initialReady).toBeVisible({ timeout: 60_000 });
  const initialReadyText = await initialReady.textContent();
  const initialGeneration = Number(initialReadyText?.match(/\d+/)?.[0]);
  expect(Number.isSafeInteger(initialGeneration)).toBe(true);
  const firstReadyVisualizationMs = performance.now() - navigationStarted;
  const canvas = page.getByLabel(
    "Pan and zoom the 10,000 by 10,000 cell world",
  );
  await expect(canvas).toBeVisible();
  const world = page.getByRole("region", {
    name: "Interactive Game of Life world",
  });
  const firstVisibleTileMs = firstReadyVisualizationMs;

  const desktopFrameP95Ms = await measureInteractionFrames(page, world);
  await startJsHeapSampling(page);
  const switchStarted = performance.now();
  await page.getByRole("button", { name: "Advance 100,000,000 cells" }).click();
  const nextGeneration = initialGeneration + 1;
  await expect(
    page.getByText(`Advanced to ${nextGeneration}`).first(),
  ).toBeVisible({
    timeout: 330_000,
  });
  await expect(
    page.getByText(`Ready · generation ${nextGeneration}`),
  ).toBeVisible({
    timeout: 90_000,
  });
  await expect(
    page.getByText(`Visualized generation ${nextGeneration}.`),
  ).toBeAttached();
  const visibleGenerationSwitchMs = performance.now() - switchStarted;
  const peakObservedJsHeapBytes = await stopJsHeapSampling(page);

  await page.reload();
  await expect(
    page.getByText(`Ready · generation ${nextGeneration}`),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByText(`Advanced to ${nextGeneration}`).first(),
  ).toBeVisible();

  await page.setViewportSize({ width: 412, height: 915 });
  await expect(page.getByLabel("World controls")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Advance 100,000,000 cells" }),
  ).toBeVisible();
  const mobileFrameP95Ms = await measureInteractionFrames(page, world);

  const evidence = {
    schemaVersion: 1,
    referenceHost: process.env.GAME_OF_LIFE_REFERENCE_HOST ?? "unspecified",
    browser: "Chromium with SwiftShader",
    desktopViewport: "1440x900",
    mobileProfile: "412x915 emulation on the same host",
    initialGeneration,
    resultingGeneration: nextGeneration,
    firstContentMs: rounded(firstContentMs),
    firstReadyVisualizationMs: rounded(firstReadyVisualizationMs),
    firstVisibleTileMs: rounded(firstVisibleTileMs),
    visibleGenerationSwitchMs: rounded(visibleGenerationSwitchMs),
    desktopInteractionFrameP95Ms: rounded(desktopFrameP95Ms),
    mobileInteractionFrameP95Ms: rounded(mobileFrameP95Ms),
    desktopInteractionBudgetMet: desktopFrameP95Ms < 16.7,
    mobileInteractionBudgetMet: mobileFrameP95Ms < 33.3,
    peakObservedJsHeapBytes,
  };
  const evidencePath = process.env.PHASE7_BROWSER_EVIDENCE;
  if (evidencePath) {
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  await test.info().attach("phase-7-browser-evidence", {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: "application/json",
  });
  expect(browserErrors).toEqual([]);
});

async function measureInteractionFrames(
  page: import("@playwright/test").Page,
  canvas: import("@playwright/test").Locator,
): Promise<number> {
  await canvas.focus();
  const samples = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const intervals: number[] = [];
        let previous = performance.now();
        let direction = 1;
        const sample = (now: number) => {
          intervals.push(now - previous);
          previous = now;
          document.activeElement?.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: direction > 0 ? "ArrowRight" : "ArrowLeft",
              bubbles: true,
            }),
          );
          direction *= -1;
          if (intervals.length === 120) resolve(intervals.slice(1));
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  const intervals = await samples;
  intervals.sort((left, right) => left - right);
  return intervals[Math.ceil(intervals.length * 0.95) - 1]!;
}

async function startJsHeapSampling(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(() => {
    const target = window as typeof window & {
      phase7HeapSamples?: number[];
      phase7HeapTimer?: number;
    };
    target.phase7HeapSamples = [];
    target.phase7HeapTimer = window.setInterval(() => {
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize: number };
        }
      ).memory;
      if (memory) target.phase7HeapSamples!.push(memory.usedJSHeapSize);
    }, 100);
  });
}

async function stopJsHeapSampling(
  page: import("@playwright/test").Page,
): Promise<number> {
  return page.evaluate(() => {
    const target = window as typeof window & {
      phase7HeapSamples?: number[];
      phase7HeapTimer?: number;
    };
    if (target.phase7HeapTimer !== undefined)
      clearInterval(target.phase7HeapTimer);
    return Math.max(...(target.phase7HeapSamples ?? [0]));
  });
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
