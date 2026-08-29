import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

const browserErrors = new WeakMap<object, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => expect(browserErrors.get(page) ?? []).toEqual([]));

test("renders one immutable generation with accessible controls", async ({
  page,
}) => {
  const indexerRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/worlds/"))
      indexerRequests.push(request.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Life Observatory" }),
  ).toBeVisible();
  await expect(page.getByText(/Immutable generation 0/)).toBeVisible();
  await expect(
    page.getByLabel("Pan and zoom the 10,000 by 10,000 cell world"),
  ).toBeVisible();
  for (const name of ["Zoom out", "Zoom in", "Fit world", "Reset north-up"])
    await expect(page.getByRole("button", { name })).toBeEnabled();
  await expect(page.getByText(/Visualization unavailable/)).toHaveCount(0);
  await expect(page.getByText("3,072 cells")).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");
  expect(indexerRequests.length).toBeGreaterThan(0);
  expect(
    indexerRequests.every((url) =>
      new URL(url).pathname.startsWith("/groundhog-indexer/"),
    ),
  ).toBe(true);
});

test("buttons and keyboard update bounded shareable camera state", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByLabel("Pan and zoom the 10,000 by 10,000 cell world"),
  ).toBeVisible();
  for (let count = 0; count < 3; count += 1)
    await page.getByRole("button", { name: "Zoom in" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("z"))
    .not.toBe("-6.000");
  const canvas = page.getByLabel(
    "Pan and zoom the 10,000 by 10,000 cell world",
  );
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const wheelZoom = new URL(page.url()).searchParams.get("z");
  await page.mouse.wheel(0, 500);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("z"))
    .not.toBe(wheelZoom);
  const dragX = new URL(page.url()).searchParams.get("x");
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2 + 90,
    box!.y + box!.height / 2 + 35,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("x"))
    .not.toBe(dragX);
  await canvas.focus();
  await page.keyboard.press("0");
  await expect
    .poll(() => Number(new URL(page.url()).searchParams.get("x")))
    .toBe(5000);
  for (let count = 0; count < 3; count += 1)
    await page.getByRole("button", { name: "Zoom in" }).click();
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => Number(new URL(page.url()).searchParams.get("x")))
    .toBeGreaterThan(5000);
});

test("decodes density and exact cells for retained CPU inspection", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.getByLabel(
    "Pan and zoom the 10,000 by 10,000 cell world",
  );
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByText(/cells live$/)).toBeVisible();
  for (let count = 0; count < 12; count += 1)
    await page.getByRole("button", { name: "Zoom in" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("z"))
    .toBe("0.000");
  await page.mouse.move(
    box!.x + box!.width / 2 + 1,
    box!.y + box!.height / 2 + 1,
  );
  await expect(page.getByText(/exact cell.*· (live|dead)$/)).toBeVisible();
});

test("supports tab focus and keyboard center inspection", async ({ page }) => {
  const initialTile = page.waitForResponse(
    (response) => response.url().includes("/tiles/") && response.ok(),
  );
  await page.goto("/");
  await initialTile;
  const canvas = page.getByLabel(
    "Pan and zoom the 10,000 by 10,000 cell world",
  );
  await expect(canvas).toHaveAccessibleDescription(/Enter to inspect/);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(canvas).toBeFocused();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByText(/Generation 0 · aggregate at x/)).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByText(/Move over a loaded tile/)).toBeVisible();
  await canvas.focus();
  await expect
    .poll(async () => {
      await page.keyboard.press("Enter");
      return page
        .getByRole("status")
        .filter({ hasText: /Generation 0/ })
        .textContent();
    })
    .toMatch(/aggregate at x/);
  await expect(
    page.getByRole("group", { name: "World controls" }),
  ).toBeVisible();
  const exactTile = page.waitForResponse(
    (response) =>
      response.url().includes("/tiles/6/19/19.bin") && response.ok(),
  );
  for (let count = 0; count < 12; count += 1) await page.keyboard.press("+");
  await exactTile;
  await page.mouse.move(
    box!.x + box!.width / 2 + 1,
    box!.y + box!.height / 2 + 1,
  );
  await expect(page.getByText(/Generation 0 · exact cell x/)).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByText(/Move over a loaded tile/)).toBeVisible();
  await canvas.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Generation 0 · exact cell x/)).toBeVisible();
});

test("never exceeds eight concurrent immutable tile requests", async ({
  page,
}) => {
  let active = 0;
  let maximum = 0;
  await page.route("**/tiles/**/*.bin", async (route) => {
    active += 1;
    maximum = Math.max(maximum, active);
    let counted = true;
    try {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      counted = false;
      await route.fulfill({ response });
    } catch {
      /* Superseded tile requests are expected to be canceled. */
    } finally {
      if (counted) active -= 1;
    }
  });
  await page.goto("/");
  await expect(
    page.getByLabel("Pan and zoom the 10,000 by 10,000 cell world"),
  ).toBeVisible();
  await expect.poll(() => maximum).toBeGreaterThan(0);
  await expect.poll(() => active).toBe(0);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(() => active).toBe(0);
  expect(maximum).toBeLessThanOrEqual(8);
});

test("renders deterministic pixels and rebuilds after real context loss", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.getByLabel(
    "Pan and zoom the 10,000 by 10,000 cell world",
  );
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const inspection = page.getByText(/Generation 0 · aggregate at x/);
  await expect(inspection).toBeVisible();
  const beforeInspection = await inspection.textContent();
  const before = await screenshotHash(canvas);
  expect(before.bytes).toBeGreaterThan(1_000);
  const background = await backgroundHash(page, canvas);
  expect(before.hash).not.toBe(background);
  const supported = await canvas.evaluate((element) => {
    const gl = (element as HTMLCanvasElement).getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_lose_context") ?? null;
    (
      window as typeof window & { lifeContext?: WEBGL_lose_context }
    ).lifeContext = extension ?? undefined;
    extension?.loseContext();
    return extension !== null;
  });
  expect(supported).toBe(true);
  await expect(page.getByText(/WebGL context lost/)).toBeVisible();
  await page.evaluate(() => {
    (
      window as typeof window & { lifeContext?: WEBGL_lose_context }
    ).lifeContext?.restoreContext();
  });
  await expect(page.getByText(/WebGL context lost/)).toHaveCount(0);
  await expect(page.getByText(/Immutable generation 0/)).toBeVisible();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.mouse.move(
    box!.x + box!.width / 2 + 24,
    box!.y + box!.height / 2 + 18,
  );
  await expect
    .poll(() => page.getByText(/Generation 0 · aggregate at x/).textContent())
    .not.toBe(beforeInspection);
  await expect
    .poll(async () => (await screenshotHash(canvas)).hash)
    .not.toBe(background);
});

async function screenshotHash(locator: import("@playwright/test").Locator) {
  const image = await locator.screenshot();
  return {
    bytes: image.byteLength,
    hash: createHash("sha256").update(image).digest("hex"),
  };
}

async function backgroundHash(
  page: import("@playwright/test").Page,
  canvas: import("@playwright/test").Locator,
): Promise<string> {
  await canvas.evaluate((source) => {
    const element = source as HTMLCanvasElement;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const reference = document.createElement("canvas");
    reference.id = "background-reference";
    reference.width = element.width;
    reference.height = element.height;
    Object.assign(reference.style, {
      position: "fixed",
      inset: "0 auto auto 0",
      zIndex: "9999",
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backgroundPosition: style.backgroundPosition,
      backgroundSize: style.backgroundSize,
    });
    document.body.append(reference);
  });
  const reference = page.locator("#background-reference");
  const result = (await screenshotHash(reference)).hash;
  await reference.evaluate((element) => element.remove());
  return result;
}

test("keeps metadata usable when WebGL2 is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === "webgl2") return null;
      return original.call(this, type, ...args) as RenderingContext | null;
    } as typeof original;
  });
  await page.goto("/");
  await expect(page.getByText(/Immutable generation 0/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Visualization unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText(/metadata and provenance remain available/i),
  ).toBeVisible();
});

test("preserves controls and world context at 320 CSS pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await expect(page.getByLabel("World controls")).toBeVisible();
  const box = await page.getByRole("button", { name: "Zoom in" }).boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(36);
  await expect(page.getByLabel("World minimap")).toBeHidden();
});

test("survives repeated renderer mounts and cache stress", async ({ page }) => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await page.goto("/");
    const canvas = page.getByLabel(
      "Pan and zoom the 10,000 by 10,000 cell world",
    );
    await expect(canvas).toBeVisible();
    for (let step = 0; step < 4; step += 1)
      await page.getByRole("button", { name: "Zoom in" }).click();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.getByText(/Generation 0 · aggregate at x/)).toBeVisible();
    await page.goto("about:blank");
  }
});

test("distinguishes a missing tile without discarding the renderer", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.getByLabel(
    "Pan and zoom the 10,000 by 10,000 cell world",
  );
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByText(/Generation 0 · aggregate at x/)).toBeVisible();
  const normal = await screenshotHash(canvas);
  const centerTile = await page.evaluate(() => {
    const resources = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => url.includes("/tiles/"));
    const candidates = resources
      .map((url) => {
        const match = new URL(url).pathname.match(
          /\/tiles\/(\d+)\/(\d+)\/(\d+)\.bin$/,
        );
        if (!match) return null;
        const [z, x, y] = match.slice(1).map(Number) as [
          number,
          number,
          number,
        ];
        const span = 256 * 2 ** (6 - z);
        return x * span <= 5000 &&
          5000 < (x + 1) * span &&
          y * span <= 5000 &&
          5000 < (y + 1) * span
          ? { url, z }
          : null;
      })
      .filter((value): value is { url: string; z: number } => value !== null)
      .sort((left, right) => right.z - left.z);
    return candidates[0]?.url ?? null;
  });
  expect(centerTile).not.toBeNull();
  let missingRequests = 0;
  await page.route(centerTile!, (route) => {
    missingRequests += 1;
    return route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "missing",
    });
  });
  await page.goto("/");
  await expect(
    page.getByText(/Tile unavailable; showing diagonal hatch/),
  ).toBeVisible();
  expect(missingRequests).toBeGreaterThan(0);
  const missingCanvas = page.getByLabel(
    "Pan and zoom the 10,000 by 10,000 cell world",
  );
  await expect
    .poll(async () => (await screenshotHash(missingCanvas)).hash)
    .not.toBe(normal.hash);
  const missing = await screenshotHash(missingCanvas);
  expect(missing.hash).not.toBe(normal.hash);
  await expect(
    page.getByRole("heading", { name: "Visualization unavailable" }),
  ).toHaveCount(0);
});
