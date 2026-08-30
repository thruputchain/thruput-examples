import { expect, test } from "@playwright/test";

const browserErrors = new WeakMap<object, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.request.get("/__life-fixture?reset=1");
});

test.afterEach(({ page }) => expect(browserErrors.get(page) ?? []).toEqual([]));

test("loads the X-Ray route directly without world payloads", async ({
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
  expect(dataRequests).toEqual([]);
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

test("keeps the Phase 1 instrument within a 320 pixel viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/xray");
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Block/ })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
