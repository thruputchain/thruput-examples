import { expect, test, type Locator, type Page } from "@playwright/test";

const browserErrors = new WeakMap<object, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.request.get("/__life-fixture?reset=1");
});

test.afterEach(({ page }) => expect(browserErrors.get(page) ?? []).toEqual([]));

test("loads read-only X-Ray evidence without world payloads", async ({
  page,
}) => {
  const applicationRequests: string[] = [];
  const dataRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    applicationRequests.push(url.pathname);
    if (
      url.pathname.startsWith("/groundhog-rpc") ||
      url.pathname.startsWith("/groundhog-indexer") ||
      url.pathname.includes("/tiles/")
    )
      dataRequests.push(url.pathname);
  });

  await page.request.get("/__life-fixture?chain=1&published=1&evidence=event");
  await page.goto("/xray");

  await expect(
    page.getByRole("heading", {
      name: "100,000,000 cells. One atomic transition.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bank A" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bank B" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Cell/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByText(/RELATIONSHIP \/ Chain and snapshot aligned/),
  ).toBeVisible();
  const snapshotEvidence = page
    .getByRole("article")
    .filter({ hasText: "Immutable visualization snapshot" });
  await expect(snapshotEvidence).toContainText("generation-advanced-event");
  await expect(snapshotEvidence).toContainText("GenerationAdvanced");
  await expect(snapshotEvidence).toContainText("Event index1");
  await expect(snapshotEvidence).toContainText(`0x${"cc".repeat(32)}`);
  await expect(snapshotEvidence).toContainText(`0x${"ef".repeat(32)}`);
  await expect(snapshotEvidence).toContainText("2026-08-28T01:02:03Z");
  await expect(
    page
      .getByRole("heading", { name: "Inspectable claim bundle" })
      .locator(".."),
  ).toContainText(/GenerationAdvanced \/ event index 1 \/ request/);
  await expect(page.getByText(/individual tile proofs do not/i)).toBeVisible();
  expect(
    dataRequests.filter(
      (path) =>
        !path.startsWith("/groundhog-rpc") &&
        !path.endsWith("/latest.json") &&
        !path.endsWith("/manifest.json") &&
        !path.endsWith("/provenance.json"),
    ),
  ).toEqual([]);
  expect(
    dataRequests.filter((path) => path.startsWith("/groundhog-rpc")),
  ).toHaveLength(1);
  expect(
    dataRequests.filter((path) => path.endsWith("/latest.json")),
  ).toHaveLength(1);
  expect(
    dataRequests.filter((path) => path.endsWith("/manifest.json")),
  ).toHaveLength(1);
  expect(
    dataRequests.filter((path) => path.endsWith("/provenance.json")),
  ).toHaveLength(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await clippedContent(page)).toEqual([]);
  expect(
    applicationRequests.filter((path) =>
      [
        "world-bootstrap",
        "development-personas",
        "/transactions/",
        "/components/world-viewport",
      ].some((privatePath) => path.includes(privatePath)),
    ),
  ).toEqual([]);
});

test("keeps the complete educational path when both live sources fail", async ({
  page,
}) => {
  await page.request.get("/__life-fixture?latest=unavailable&rpc=unavailable");
  await page.goto("/xray");
  await expect(
    page.getByText(/RELATIONSHIP \/ No live evidence/),
  ).toBeVisible();
  await expect(
    page.locator('[data-relationship="no-live-evidence"]'),
  ).toContainText(/Fixed contract-derived explanations remain available/);
  await expect(
    page.getByRole("heading", {
      name: "100,000,000 cells. One atomic transition.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Ask the same atomic workload of every system",
    }),
  ).toBeVisible();
  for (const heading of [
    "From one cell to one committed block",
    "Two persistent banks, one atomic handoff",
    "Pinpoint any cell in canonical storage",
    "One invocation, one indivisible outcome",
    "Three zones, no transferred authority",
  ])
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
});

test("supports keyboard focus, semantic headings, and retry announcements", async ({
  page,
}) => {
  await page.goto("/xray");
  await expect(
    page.getByText(/RELATIONSHIP \/ Chain and snapshot aligned/),
  ).toBeVisible();
  expect(await page.locator("h1").count()).toBe(1);
  const levels = await page
    .locator("h1, h2, h3, h4, h5, h6")
    .evaluateAll((headings) =>
      headings.map((heading) => Number(heading.tagName.slice(1))),
    );
  expect(levels[0]).toBe(1);
  expect(
    levels.every(
      (level, index) => index === 0 || level <= levels[index - 1]! + 1,
    ),
  ).toBe(true);

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to X-Ray content" });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#xray-content$/);

  const coordinateX = page.getByRole("textbox", { name: "Coordinate x" });
  const coordinateY = page.getByRole("textbox", { name: "Coordinate y" });
  const locate = page.getByRole("button", { name: "Locate cell" });
  await tabUntil(page, coordinateX, 16);
  await page.keyboard.press("Control+A");
  await page.keyboard.type("12");
  await page.keyboard.press("Tab");
  await expect(coordinateY).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("34");
  await page.keyboard.press("Tab");
  await expect(locate).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/cellX=12&cellY=34/);

  const retry = page.getByRole("button", { name: "Refresh evidence" });
  await page.route("**/latest.json", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await tabUntil(page, retry, 4);
  await expect(retry).toBeFocused();
  expect(
    await retry.evaluate(
      (element) => getComputedStyle(element).boxShadow !== "none",
    ),
  ).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator('p[aria-live="polite"]:not([role])')).toHaveText(
    "Evidence refresh requested.",
  );

  expect(await page.getByRole("button", { name: /\S/ }).count()).toBe(
    await page.getByRole("button").count(),
  );
  expect(await page.getByRole("link", { name: /\S/ }).count()).toBe(
    await page.getByRole("link").count(),
  );
  await expect(
    page.getByRole("textbox", { name: "Coordinate x" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Coordinate y" }),
  ).toBeVisible();
});

test("meets automated theme-token contrast checks", async ({ page }) => {
  await page.goto("/xray");
  const ratios = await page.evaluate(() => {
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
    const contrast = (left: string, right: string) => {
      const a = luminance(rgb(style.getPropertyValue(left)));
      const b = luminance(rgb(style.getPropertyValue(right)));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    return {
      foreground: contrast("--foreground", "--background"),
      muted: contrast("--muted-foreground", "--background"),
      primary: contrast("--primary", "--background"),
      warning: contrast("--warning", "--background"),
      selectedEdge: contrast("--warning", "--panel"),
    };
  });
  expect(ratios.foreground).toBeGreaterThanOrEqual(4.5);
  expect(ratios.muted).toBeGreaterThanOrEqual(4.5);
  expect(ratios.primary).toBeGreaterThanOrEqual(4.5);
  expect(ratios.warning).toBeGreaterThanOrEqual(4.5);
  expect(ratios.selectedEdge).toBeGreaterThanOrEqual(3);
});

test("keeps chain and indexer failures independent", async ({ page }) => {
  await page.request.get("/__life-fixture?latest=unavailable");
  await page.goto("/xray");
  await expect(page.getByText(/RELATIONSHIP \/ Chain only/)).toBeVisible();
  await expect(page.getByText("● Unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("32,768", { exact: true })).toBeVisible();

  await page.request.get("/__life-fixture?reset=1&rpc=unavailable");
  await page.reload();
  await expect(
    page.getByText(/RELATIONSHIP \/ Snapshot retained/),
  ).toBeVisible();
  await expect(page.getByText("● Unavailable", { exact: true })).toBeVisible();
  await expect(
    page.locator('[data-relationship="snapshot-retained"]'),
  ).toContainText(/is retained evidence and is not labeled as current/);

  await page.request.get("/__life-fixture?reset=1&rpc=malformed");
  await page.reload();
  await expect(
    page.getByText(/RELATIONSHIP \/ Snapshot retained/),
  ).toBeVisible();
  await expect(page.getByText(/Malformed · rejected/)).toBeVisible();

  await page.request.get("/__life-fixture?reset=1&rpc=malformed-schema");
  await page.reload();
  await expect(page.getByText(/Malformed · rejected/)).toBeVisible();

  await page.request.get("/__life-fixture?reset=1&rpc=malformed-envelope");
  await page.reload();
  await expect(page.getByText(/Malformed · rejected/)).toBeVisible();
});

test("rejects a malformed refresh without losing retained evidence", async ({
  page,
}) => {
  await page.goto("/xray");
  await expect(
    page.getByText(/RELATIONSHIP \/ Chain and snapshot aligned/),
  ).toBeVisible();
  await page.request.get("/__life-fixture?latest=malformed");
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(
    page.getByText(/RELATIONSHIP \/ Retained snapshot; incompatible refresh/),
  ).toBeVisible();
  await expect(
    page.getByText(/Stale · malformed refresh rejected/),
  ).toBeVisible();
});

test("rejects malformed and ineligible snapshot evidence", async ({ page }) => {
  await page.request.get("/__life-fixture?latest=malformed");
  await page.goto("/xray");
  await expect(
    page.getByText(/RELATIONSHIP \/ Incompatible snapshot/),
  ).toBeVisible();
  await expect(page.getByText(/Malformed · rejected/)).toBeVisible();

  await page.request.get(
    "/__life-fixture?reset=1&chain=2&published=1&evidence=metadata",
  );
  await page.reload();
  await expect(
    page.getByText(/RELATIONSHIP \/ Integrity conflict/),
  ).toBeVisible();
  await expect(
    page.locator('[data-relationship="integrity-conflict"]'),
  ).toContainText(/metadata observation does not describe current chain state/);
  const rejected = page.getByRole("article").filter({
    hasText: "Immutable visualization snapshot",
  });
  await rejected.getByText("Rejected snapshot identity").click();
  await expect(rejected.getByText("1", { exact: true })).toBeVisible();
  await expect(rejected).toContainText(
    "not used as visualized or headline evidence",
  );
});

test("supports direct trailing-slash and not-found routes", async ({
  page,
}) => {
  await page.goto("/xray/");
  await expect(
    page.getByRole("heading", { name: /One atomic transition/ }),
  ).toBeVisible();

  await page.goto("/missing-observation");
  await expect(
    page.getByRole("heading", {
      name: "This observation point does not exist.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Transaction X-Ray" }),
  ).toHaveAttribute("href", "/xray");
});

test("navigates between the world and X-Ray with ordinary links", async ({
  page,
}) => {
  await page.goto("/xray");
  await page.getByRole("link", { name: "World" }).click();
  await expect(
    page.getByRole("heading", { name: "Life Observatory" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "X-Ray" }).click();
  await expect(
    page.getByRole("heading", { name: /One atomic transition/ }),
  ).toBeVisible();
});

test("maps and shares an exact boundary cell without losing other query state", async ({
  page,
}) => {
  await page.goto("/xray?view=proof");
  await page.getByLabel("Coordinate x").fill("9999");
  await page.getByLabel("Coordinate y").fill("9999");
  await page.getByRole("button", { name: "Locate cell" }).click();

  await expect(page).toHaveURL(/\/xray\?view=proof&cellX=9999&cellY=9999$/);
  await expect(page.getByLabel("Bit 7, cell x 9999, selected")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByRole("status")).toHaveText(
    "Cell 9999, 9999 maps to chunk 19999, byte 249, bit 7.",
  );

  await page.getByLabel("Coordinate x").fill("10000");
  await page.getByRole("button", { name: "Locate cell" }).click();
  await expect(page.getByRole("alert")).toContainText("0 through 9,999");
  await expect(page).toHaveURL(/\/xray\?view=proof&cellX=9999&cellY=9999$/);

  await page.reload();
  await expect(page.getByLabel("Coordinate x")).toHaveValue("9999");
  await expect(page.getByLabel("Coordinate y")).toHaveValue("9999");
});

test("explains the complete atomic tick without inventing receipt measurements", async ({
  page,
}) => {
  await page.goto("/xray");
  await page
    .getByRole("heading", { name: "One invocation, one indivisible outcome" })
    .scrollIntoViewIfNeeded();
  const stages = page
    .getByRole("list", { name: "Atomic tick stages" })
    .getByRole("listitem");
  await expect(stages).toHaveCount(7);
  await expect(stages.nth(0)).toContainText("Read required world state");
  await expect(stages.nth(6)).toContainText(
    "Committed block or complete revert",
  );
  await expect(page.getByText(/interleaves stages 03 and 04/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Count what the contract must do" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Receipt measurement not connected/i),
  ).toBeVisible();
  await expect(page.getByText(/does not infer consumption/)).toBeVisible();
});

test("keeps the transaction explanation complete under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/xray");
  await page
    .getByRole("heading", { name: "One invocation, one indivisible outcome" })
    .scrollIntoViewIfNeeded();
  await expect(
    page
      .getByRole("list", { name: "Atomic tick stages" })
      .getByRole("listitem"),
  ).toHaveCount(7);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("keeps the microscope usable within a 320 pixel viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/xray");
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Block/ })).toBeVisible();
  await page
    .getByRole("heading", { name: "Pinpoint any cell in canonical storage" })
    .scrollIntoViewIfNeeded();
  await expect(page.getByLabel("Coordinate x")).toBeVisible();
  await expect(page.getByLabel("Coordinate y")).toBeVisible();
  await expect(page.getByRole("button", { name: "Locate cell" })).toBeVisible();
  expect(
    await page
      .getByRole("list", { name: /bit positions/ })
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await clippedContent(page)).toEqual([]);
});

test("keeps microscope controls operable in mobile landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 780, height: 360 });
  await page.request.get(
    "/__life-fixture?chain=2&published=1&evidence=metadata",
  );
  await page.goto("/xray?cellX=8&cellY=9");
  await page
    .getByRole("heading", { name: "Pinpoint any cell in canonical storage" })
    .scrollIntoViewIfNeeded();
  const coordinateX = page.getByRole("textbox", { name: "Coordinate x" });
  const coordinateY = page.getByRole("textbox", { name: "Coordinate y" });
  await expect(coordinateX).toHaveValue("8");
  await expect(coordinateY).toHaveValue("9");
  await tabUntil(page, coordinateX, 16);
  await page.keyboard.press("Control+A");
  await page.keyboard.type("7");
  await page.keyboard.press("Tab");
  await expect(coordinateY).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Locate cell" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/cellX=7&cellY=9/);
  const disclosure = page.getByText("Rejected snapshot identity");
  await disclosure.scrollIntoViewIfNeeded();
  await tabUntil(page, disclosure, 4);
  await page.keyboard.press("Enter");
  await expect(disclosure.locator("..")).toHaveAttribute("open", "");
  const rejectedSnapshot = page.getByRole("article").filter({
    hasText: "Immutable visualization snapshot",
  });
  await expect(
    rejectedSnapshot.getByText(`0x${"dd".repeat(32)}`),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Three zones, no transferred authority",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await clippedContent(page)).toEqual([]);
});

async function clippedContent(page: Page): Promise<string[]> {
  return page.locator("body *").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const insideHorizontalScroller = Boolean(
        element.closest("[data-xray-horizontal-scroll]"),
      );
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        box.width === 0 ||
        box.height === 0 ||
        element.closest("[aria-live]") ||
        insideHorizontalScroller
      )
        return [];
      if (box.left >= -0.5 && box.right <= window.innerWidth + 0.5) return [];
      return [
        `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}: ${element.textContent?.trim().slice(0, 60) ?? ""}`,
      ];
    }),
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
  await expect(target).toBeFocused();
}
