import { expect, test } from "@playwright/test";

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
  expect(dataRequests.filter((path) => path.includes("/tiles/"))).toEqual([]);
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
});

test("keeps microscope controls operable in mobile landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 780, height: 360 });
  await page.goto("/xray?cellX=8&cellY=9");
  await page
    .getByRole("heading", { name: "Pinpoint any cell in canonical storage" })
    .scrollIntoViewIfNeeded();
  await expect(page.getByLabel("Coordinate x")).toHaveValue("8");
  await expect(page.getByLabel("Coordinate y")).toHaveValue("9");
  await page.getByLabel("Coordinate x").fill("7");
  await page.getByRole("button", { name: "Locate cell" }).click();
  await expect(page).toHaveURL(/cellX=7&cellY=9/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
