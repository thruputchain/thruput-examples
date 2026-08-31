import { expect, test, type Locator, type Page } from "@playwright/test";

const browserErrors = new WeakMap<object, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.request.get("/__life-fixture?reset=1");
});

test.afterEach(({ page }) => expect(browserErrors.get(page) ?? []).toEqual([]));

test("loads metadata without loading exact cells or the world runtime", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) =>
    requests.push(new URL(request.url()).pathname),
  );

  await page.goto("/xray");
  await expect(
    page.getByRole("heading", { name: "Transaction X-Ray" }),
  ).toBeVisible();
  await expect(
    page.getByText("Chain and snapshot aligned", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    "No exact cell data loaded.",
  );

  expect(requests.filter(isExactTile)).toEqual([]);
  expect(requests.filter((path) => path === "/groundhog-rpc")).toHaveLength(1);
  expect(requests.filter((path) => path.endsWith("/latest.json"))).toHaveLength(
    1,
  );
  expect(
    requests.filter((path) => path.endsWith("/manifest.json")),
  ).toHaveLength(1);
  expect(
    requests.filter((path) => path.endsWith("/provenance.json")),
  ).toHaveLength(1);
  expect(
    requests.filter((path) =>
      [
        "world-bootstrap",
        "development-personas",
        "/transactions/",
        "world-viewport",
      ].some((privatePath) => path.includes(privatePath)),
    ),
  ).toEqual([]);
});

test("loads one exact tile and shows the cell, storage, and next value", async ({
  page,
}) => {
  const exactTiles: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (isExactTile(path)) exactTiles.push(path);
  });

  await page.goto("/xray");
  await page.getByRole("button", { name: "Inspect exact cell" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Loaded cell 5000, 5000 from generation 0.",
  );
  expect(exactTiles).toHaveLength(1);
  await expect(
    page
      .getByRole("list", { name: "Selected cell neighborhood" })
      .getByRole("listitem"),
  ).toHaveCount(9);
  await expect(
    page
      .getByRole("list", { name: "Byte 625 bit values" })
      .getByRole("listitem"),
  ).toHaveCount(8);
  await expect(page.getByText("floor(5,000 ÷ 8)")).toBeVisible();
  await expect(page.getByText("5,000 × 2 + 0")).toBeVisible();
  await expect(
    page.getByText(/\d live neighbors → (Birth|Survival|Death|Remains dead)/),
  ).toBeVisible();
  await expect(page.getByText("Current / Bank A")).toBeVisible();
  await expect(page.getByText("Next / Bank B")).toBeVisible();
  await expect(
    page.getByText(
      /Same location: row 5,000 \/ key 10,000 \/ byte 625 \/ bit 0/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText("One byte holds 8 cells.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("This is position 1 of 8", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("COMMIT BOUNDARY")).toHaveCount(0);
});

test("connects one bit to the fixed tick and cited execution envelopes", async ({
  page,
}) => {
  await page.goto("/xray");
  await page.waitForLoadState("networkidle");
  const interactionRequests: string[] = [];
  page.on("request", (request) =>
    interactionRequests.push(new URL(request.url()).pathname),
  );

  const scale = page.getByRole("list", { name: "Storage scale levels" });
  await scale.getByRole("button", { name: /One bank/ }).click();
  await expect(
    page.getByText("10,000 rows × 1,250 bytes = 12,500,000 bytes", {
      exact: true,
    }),
  ).toBeVisible();
  await scale.getByRole("button", { name: /Persistent world/ }).click();
  await expect(
    page.getByText("2 banks × 12,500,000 bytes = 25,000,000 bytes", {
      exact: true,
    }),
  ).toBeVisible();

  const phases = page.getByRole("list", { name: "Atomic tick phases" });
  await phases.getByRole("button", { name: /Evaluate world/ }).click();
  await expect(page.getByText("100,000,000", { exact: true })).toBeVisible();
  await phases.getByRole("button", { name: /Write destination/ }).click();
  await expect(page.getByText("12,500,000", { exact: true })).toBeVisible();
  await phases.getByRole("button", { name: /Commit together/ }).click();
  await expect(
    page.getByText("Generation + bank switch", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Queue slot + event", { exact: true }),
  ).toBeVisible();

  await expect(page.getByText("10,485,760 bytes max / account")).toBeVisible();
  await expect(page.getByText("0.014 CU available / cell")).toBeVisible();
  await expect(page.getByText("0.6 gas available / cell")).toBeVisible();
  await expect(page.getByText("Possible on Groundhog")).toBeVisible();
  await expect(
    page.getByText("Blocked by the transaction compute cap"),
  ).toBeVisible();
  await expect(
    page.getByText("Blocked by storage gas + compute gas"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Solana compute budget" }),
  ).toHaveAttribute("href", "https://solana.com/docs/core/fees");
  expect(interactionRequests).toEqual([]);
});

test("loads only four deduplicated exact tiles for a wrapped corner", async ({
  page,
}) => {
  const exactTiles: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (isExactTile(path)) exactTiles.push(path);
  });

  await page.goto("/xray?cellX=0&cellY=0&view=proof");
  await page.getByRole("button", { name: "Inspect exact cell" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Loaded cell 0, 0 from generation 0.",
  );
  expect(new Set(exactTiles.map(tileCoordinates))).toEqual(
    new Set(["6/39/39", "6/0/39", "6/39/0", "6/0/0"]),
  );
  expect(exactTiles).toHaveLength(4);
  await expect(page.getByLabel(/Cell 9999, 9999: (alive|dead)/)).toBeVisible();
  await expect(page.getByLabel(/Cell 0, 0: .*selected/)).toBeVisible();
});

test("supersedes an in-flight inspection with the latest coordinate", async ({
  page,
}) => {
  await page.request.get("/__life-fixture?chain=1&published=1&tileDelay=500");
  await page.goto("/xray");
  await page.getByLabel("Coordinate x").fill("0");
  await page.getByLabel("Coordinate y").fill("0");
  await page.getByRole("button", { name: "Inspect exact cell" }).click();
  await page.getByLabel("Coordinate x").fill("12");
  await page.getByLabel("Coordinate y").fill("34");
  await page.getByRole("button", { name: "Inspect exact cell" }).click();

  await expect(page.getByRole("status")).toHaveText(
    "Loaded cell 12, 34 from generation 1.",
  );
  await expect(page).toHaveURL(/cellX=12&cellY=34/);
});

test("preserves share state and rejects invalid coordinates", async ({
  page,
}) => {
  await page.goto("/xray?view=proof");
  await page.getByLabel("Coordinate x").fill("9999");
  await page.getByLabel("Coordinate y").fill("9999");
  await page.getByRole("button", { name: "Inspect exact cell" }).click();
  await expect(page).toHaveURL(/\/xray\?view=proof&cellX=9999&cellY=9999$/);
  await expect(page.getByRole("status")).toContainText(
    "Loaded cell 9999, 9999",
  );

  await page.getByLabel("Coordinate x").fill("10000");
  await page.getByRole("button", { name: "Inspect exact cell" }).click();
  await expect(page.getByRole("alert")).toContainText("0 through 9,999");
  await expect(page).toHaveURL(/cellX=9999&cellY=9999$/);
});

test("keeps chain and indexer evidence independent", async ({ page }) => {
  await page.request.get("/__life-fixture?latest=unavailable");
  await page.goto("/xray");
  await expect(page.getByText("Chain only", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect exact cell" }),
  ).toBeDisabled();

  await page.request.get("/__life-fixture?reset=1&rpc=unavailable");
  await page.reload();
  await expect(
    page.getByText("Snapshot retained", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect exact cell" }),
  ).toBeEnabled();
});

test("retains accepted evidence when a refresh regresses", async ({ page }) => {
  await page.request.get("/__life-fixture?chain=1&published=1");
  await page.goto("/xray");
  const relationship = page.getByText("Chain and snapshot aligned", {
    exact: true,
  });
  await expect(relationship).toBeVisible();
  await page.request.get("/__life-fixture?published=0");
  await page.getByRole("button", { name: /Refresh evidence/ }).click();

  await expect(
    page.getByText("Retained snapshot; conflicting refresh", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect exact cell" }),
  ).toBeEnabled();
});

test("keeps accepted snapshot inspection enabled after a chain regression", async ({
  page,
}) => {
  await page.request.get("/__life-fixture?chain=1&published=1");
  await page.goto("/xray");
  const relationship = page.getByText("Chain and snapshot aligned", {
    exact: true,
  });
  await expect(relationship).toBeVisible();

  await page.request.get("/__life-fixture?chain=0");
  await page.getByRole("button", { name: /Refresh evidence/ }).click();

  await expect(
    page.getByText("Integrity conflict", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect exact cell" }),
  ).toBeEnabled();
});

test("rejects malformed and chain-ineligible snapshot evidence", async ({
  page,
}) => {
  await page.request.get("/__life-fixture?latest=malformed");
  await page.goto("/xray");
  await expect(
    page.getByText("Incompatible snapshot", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect exact cell" }),
  ).toBeDisabled();

  await page.request.get(
    "/__life-fixture?reset=1&chain=2&published=1&evidence=metadata",
  );
  await page.reload();
  await expect(
    page.getByText("Integrity conflict", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect exact cell" }),
  ).toBeDisabled();
});

test("supports keyboard use, reduced motion, and a 320 pixel viewport", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/xray");
  const skip = page.getByRole("link", { name: "Skip to X-Ray content" });
  await tabUntil(page, skip, 16);
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#xray-content$/);
  await skip.evaluate((element) => (element as HTMLElement).blur());
  const refresh = page.getByRole("button", { name: /Refresh evidence/ });
  await tabUntil(page, refresh, 64);
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Enter");
  await refresh.evaluate((element) => (element as HTMLElement).blur());
  const coordinateX = page.getByRole("textbox", { name: "Coordinate x" });
  const coordinateY = page.getByRole("textbox", { name: "Coordinate y" });
  await tabUntil(page, coordinateX, 16);
  await page.keyboard.press("Control+A");
  await page.keyboard.type("12");
  await page.keyboard.press("Tab");
  await expect(coordinateY).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("34");
  await page.keyboard.press("Tab");
  const inspect = page.getByRole("button", { name: "Inspect exact cell" });
  await expect(inspect).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Loaded cell 12, 34");
  const bankScale = page
    .getByRole("list", { name: "Storage scale levels" })
    .getByRole("button", { name: /One bank/ });
  await tabUntil(page, bankScale, 16);
  await expect(bankScale).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("10,000 rows × 1,250 bytes = 12,500,000 bytes", {
      exact: true,
    }),
  ).toBeVisible();
  const evaluatePhase = page
    .getByRole("list", { name: "Atomic tick phases" })
    .getByRole("button", { name: /Evaluate world/ });
  await tabUntil(page, evaluatePhase, 16);
  await expect(evaluatePhase).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("100,000,000", { exact: true })).toBeVisible();
  const comparison = page.getByRole("region", {
    name: "Execution evidence comparison",
  });
  await tabUntil(page, comparison, 16);
  await expect(comparison).toBeFocused();
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect exact cell" }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await clippedContent(page)).toEqual([]);
});

test("preserves structure, contrast, and controls in mobile landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 780, height: 360 });
  await page.goto("/xray");
  await expect(
    page.getByRole("heading", { name: "Transaction X-Ray" }),
  ).toBeVisible();
  const levels = await page
    .locator("h1, h2, h3")
    .evaluateAll((headings) =>
      headings.map((heading) => Number(heading.tagName.slice(1))),
    );
  expect(levels[0]).toBe(1);
  expect(
    levels.every(
      (level, index) => index === 0 || level <= levels[index - 1]! + 1,
    ),
  ).toBe(true);
  expect(await page.getByRole("button", { name: /\S/ }).count()).toBe(
    await page.getByRole("button").count(),
  );
  expect(await page.getByRole("link", { name: /\S/ }).count()).toBe(
    await page.getByRole("link").count(),
  );
  await expect(page.getByLabel("Coordinate x")).toBeVisible();
  await expect(page.getByLabel("Coordinate y")).toBeVisible();
  expect(
    await themeContrast(page, "--foreground", "--background"),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    await themeContrast(page, "--muted-foreground", "--background"),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    await themeContrast(page, "--warning", "--panel"),
  ).toBeGreaterThanOrEqual(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await clippedContent(page)).toEqual([]);
});

test("supports trailing-slash, not-found, and ordinary navigation routes", async ({
  page,
}) => {
  await page.goto("/xray/");
  await expect(
    page.getByRole("heading", { name: "Transaction X-Ray" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "World" }).click();
  await expect(
    page.getByRole("heading", { name: "Life Observatory" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "X-Ray" }).click();
  await expect(
    page.getByRole("heading", { name: "Transaction X-Ray" }),
  ).toBeVisible();
  await page.goto("/missing-observation");
  await expect(
    page.getByRole("heading", {
      name: "This observation point does not exist.",
    }),
  ).toBeVisible();
});

function isExactTile(path: string): boolean {
  return /\/tiles\/6\/\d+\/\d+\.bin$/.test(path);
}

function tileCoordinates(path: string): string {
  return path.match(/\/tiles\/(6\/\d+\/\d+)\.bin$/)?.[1] ?? path;
}

async function clippedContent(page: Page): Promise<string[]> {
  return page.locator("body *").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        box.width === 0 ||
        box.height === 0 ||
        style.clip !== "auto" ||
        style.clipPath !== "none" ||
        element.closest(".sr-only") ||
        element.closest("[aria-live]") ||
        element.closest("[data-xray-horizontal-scroll]")
      )
        return [];
      if (box.left >= -0.5 && box.right <= window.innerWidth + 0.5) return [];
      return [
        `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}: ${element.textContent?.trim().slice(0, 60) ?? ""}`,
      ];
    }),
  );
}

async function themeContrast(
  page: Page,
  foreground: string,
  background: string,
): Promise<number> {
  return page.evaluate(
    ([foregroundToken, backgroundToken]) => {
      const style = getComputedStyle(document.documentElement);
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const rgb = (value: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const luminance = (color: number[]) =>
        color.reduce((total, channel, index) => {
          const normalized = channel! / 255;
          const linear =
            normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          return total + linear * [0.2126, 0.7152, 0.0722][index]!;
        }, 0);
      const left = luminance(rgb(style.getPropertyValue(foregroundToken)));
      const right = luminance(rgb(style.getPropertyValue(backgroundToken)));
      return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
    },
    [foreground, background] as const,
  );
}

async function tabUntil(
  page: Page,
  target: Locator,
  maximumTabs: number,
): Promise<void> {
  for (let index = 0; index < maximumTabs; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
}
