import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

const browserErrors = new WeakMap<object, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.request.get("/__life-fixture?reset=1");
});
test.afterEach(({ page }) => expect(browserErrors.get(page) ?? []).toEqual([]));

test("renders one immutable generation with accessible controls", async ({
  page,
}) => {
  const indexerRequests: string[] = [];
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/worlds/"))
      indexerRequests.push(request.url());
    if (!["GET", "HEAD", "OPTIONS", "POST"].includes(request.method()))
      writes.push(`${request.method()} ${request.url()}`);
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Life Observatory" }),
  ).toBeVisible();
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
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
  expect(writes).toEqual([]);
});

test("keeps accepted requests account-scoped across persona switches", async ({
  page,
}) => {
  await page.goto("/");
  const caller = `0x${"0a".padStart(64, "0")}`;
  const key = [
    "groundhog-life:requests:v1",
    "aa".repeat(32),
    caller,
    `0x${"22".repeat(32)}`,
  ].join(":");
  await page.evaluate(
    ({ key, caller }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          requests: [
            {
              schemaVersion: 1,
              localId: "accepted-alice",
              requester: caller,
              status: "accepted",
              transactionHash: `0x${"44".repeat(32)}`,
              requestId: `0x${"55".repeat(32)}`,
              receiptBlock: "7",
              submittedAt: "2026-08-29T00:00:00.000Z",
              acceptedAt: "2026-08-29T00:00:01.000Z",
              observedThroughBlock: null,
              resultingGeneration: null,
              resultingPopulation: null,
              resultingStateDigest: null,
              advancedTransactionHash: null,
              diagnostic: null,
            },
          ],
        }),
      );
    },
    { key, caller },
  );
  await page.reload();
  await expect(page.getByText("accepted", { exact: true })).toBeVisible();
  await page.getByLabel("Development persona").selectOption("bob");
  await expect(page.getByText("No local request")).toBeVisible();
  await page.getByLabel("Development persona").selectOption("alice");
  await expect(page.getByText("accepted", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Advance 100,000,000 cells" }),
  ).toBeEnabled();
});

test("does not claim initial ownership until visible GPU coverage renders", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/tiles/**/*.bin", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText("No ready visualization").first()).toBeVisible();
  await expect(page.getByText(/Ready · generation/)).toHaveCount(0);
  await expect(page.getByText(/Generation 0/).first()).toBeVisible();
  release();
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
  await expect(page.getByText("Visualized generation 0.")).toBeAttached();
});

test("missing initial tiles never receive visualization ownership", async ({
  page,
}) => {
  await page.route("**/tiles/**/*.bin", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "missing" }),
  );
  await page.goto("/");
  await expect(
    page.getByText(/Tile unavailable; showing diagonal hatch/),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByText("No ready visualization").first()).toBeVisible();
  await expect(page.getByText(/Ready · generation/)).toHaveCount(0);
  await expect(page.getByText(/Visualized generation/)).toHaveCount(0);
});

test("malformed initial artifacts never mount or receive ownership", async ({
  page,
}) => {
  await page.route("**/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: 2 }),
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText(/Indexer artifacts are malformed/).first(),
  ).toBeVisible();
  await expect(page.getByText(/Ready · generation/)).toHaveCount(0);
  await expect(
    page.getByLabel("Pan and zoom the 10,000 by 10,000 cell world"),
  ).toHaveCount(0);
});

test("GPU tile allocation failure cannot receive initial ownership", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.texStorage2D;
    WebGL2RenderingContext.prototype.texStorage2D = function (
      target,
      levels,
      internalformat,
      width,
      height,
    ) {
      if (width === 256 && height === 256)
        throw new Error("forced tile GPU allocation failure");
      return original.call(this, target, levels, internalformat, width, height);
    };
  });
  await page.goto("/");
  await expect(
    page.getByText(/forced tile GPU allocation failure/),
  ).toBeVisible();
  await expect(page.getByText(/Ready · generation/)).toHaveCount(0);
  await expect(page.getByText(/Visualized generation/)).toHaveCount(0);
});

test("supersedes a pending initial digest without committing it", async ({
  page,
}) => {
  let releaseOld!: () => void;
  const held = new Promise<void>((resolve) => (releaseOld = resolve));
  let heldOne = false;
  await page.route(`**/0x${"aa".repeat(32)}/tiles/**/*.bin`, async (route) => {
    if (!heldOne) {
      heldOne = true;
      await held;
    }
    await route.continue().catch(() => undefined);
  });
  await page.goto("/?x=5000&y=5000&z=0");
  await expect(page.getByText("No ready visualization").first()).toBeVisible();
  await page.request.get("/__life-fixture?chain=1&published=1");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.getByText("Ready · generation 1")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/Visualized generation 0/)).toHaveCount(0);
  releaseOld();
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
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
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
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
  const canvas = page.getByLabel(
    "Pan and zoom the 10,000 by 10,000 cell world",
  );
  const world = page.getByRole("region", {
    name: "Interactive Game of Life world",
  });
  await expect(world).toHaveAccessibleDescription(/Enter to inspect/);
  await expect(canvas).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(world).toBeFocused();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByText(/Generation 0 · aggregate at x/)).toBeVisible();
  const liveRegion = page.locator("main > p[aria-live]");
  const pointerAnnouncement = await liveRegion.textContent();
  expect(pointerAnnouncement).toMatch(/Ready/);
  await world.focus();
  await expect
    .poll(async () => {
      await page.keyboard.press("Enter");
      return page.getByText(/Generation 0 · aggregate at x/).textContent();
    })
    .toMatch(/aggregate at x/);
  await expect(liveRegion).not.toHaveText(pointerAnnouncement!);
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
  await canvas.dispatchEvent("pointerleave");
  await expect(page.getByText(/Move over a loaded tile/)).toBeVisible();
  await expect(liveRegion).toBeEmpty();
  await world.focus();
  await page.keyboard.press("Enter");
  await expect(liveRegion).toHaveText(
    /Generation 0, cell \d+, \d+ is (live|dead)/,
  );
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
  const initialTile = page.waitForResponse(
    (response) => response.url().includes("/tiles/") && response.ok(),
  );
  await page.goto("/");
  await initialTile;
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
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
  const contextLostStatus = page.getByText(
    "WebGL context lost. Waiting for restoration.",
  );
  await expect(contextLostStatus).toBeVisible();
  await expect(
    page.getByText("Visualization unavailable").first(),
  ).toBeVisible();
  await expect(page.getByText("Ready · generation 0")).toHaveCount(0);
  await expect(page.locator("main > p[aria-live]")).not.toContainText("Ready");
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeDisabled();
  await page.evaluate(() => {
    (
      window as typeof window & { lifeContext?: WEBGL_lose_context }
    ).lifeContext?.restoreContext();
  });
  await expect(contextLostStatus).toHaveCount(0);
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
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

async function worldPixelsHash(locator: import("@playwright/test").Locator) {
  return worldCropHash(locator);
}

async function worldBackgroundHash(
  locator: import("@playwright/test").Locator,
) {
  return worldCropHash(locator, "canvas { visibility: hidden !important; }");
}

async function worldCropHash(
  locator: import("@playwright/test").Locator,
  style?: string,
) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("World canvas has no visible bounds");
  const size = Math.min(128, box.width, box.height);
  const image = await locator.page().screenshot({
    clip: {
      x: box.x + (box.width - size) / 2,
      y: box.y + (box.height - size) / 2,
      width: size,
      height: size,
    },
    style,
  });
  return createHash("sha256").update(image).digest("hex");
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
  await expect(
    page.getByText("Visualization unavailable").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Visualization unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText(/metadata and provenance remain available/i),
  ).toBeVisible();
  await expect(page.getByText(/Ready · generation/)).toHaveCount(0);
  await expect(page.getByText("Visualization", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Activity", exact: true })
      .getByText("Unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("main > p[aria-live]")).toHaveText(
    "Visualization unavailable.",
  );
  await expect(
    page.getByRole("region", { name: "Interactive Game of Life world" }),
  ).toHaveAttribute("tabindex", "-1");
});

test("preserves controls and world context at 320 CSS pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await page.addStyleTag({
    content:
      ":root { --safe-top: 13px; --safe-right: 17px; --safe-bottom: 19px; --safe-left: 11px; }",
  });
  await expect(page.getByLabel("World controls")).toBeVisible();
  const box = await page.getByRole("button", { name: "Zoom in" }).boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(48);
  await expect(page.getByLabel("World minimap")).toBeHidden();
  const activity = page.getByRole("button", { name: "Open activity" });
  expect((await activity.boundingBox())?.width).toBeGreaterThanOrEqual(48);
  const portraitTargets = await assertVisibleTargetsFit(page, 320, 640);
  expect(portraitTargets).toEqual(
    expect.arrayContaining([
      "Homepage",
      "Open activity",
      "Open world details",
      "Zoom out",
      "Zoom in",
      "Fit world",
      "Reset north-up",
    ]),
  );
  expect(
    (await page.getByRole("link", { name: "Homepage" }).boundingBox())?.width,
  ).toBeGreaterThanOrEqual(48);
  await assertReadoutDoesNotOverlapTriggers(page);
  await assertElementsFit(page, 320, 640, [
    page.locator("header"),
    page.getByText("Ready · generation 0").locator(".."),
    page.getByText("Move over a loaded tile to inspect").locator(".."),
    page.getByLabel("World controls"),
    activity.locator(".."),
  ]);
  for (const name of ["Zoom out", "Zoom in", "Fit world", "Reset north-up"])
    await page.getByRole("button", { name }).click();
  await activity.click();
  const activityDialog = page.getByRole("dialog", {
    name: "Generation activity",
  });
  await expect(
    page.getByRole("heading", { name: "Generation activity" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog", { name: "Generation activity" })
      .getByText("On-chain", { exact: true }),
  ).toBeVisible();
  await expect(
    activityDialog.getByRole("button", { name: "Close sheet" }),
  ).toBeFocused();
  const portraitClose = await activityDialog
    .getByRole("button", { name: "Close sheet" })
    .boundingBox();
  expect(portraitClose).not.toBeNull();
  expect(portraitClose!.x + portraitClose!.width).toBeLessThanOrEqual(303);
  expect(portraitClose!.y).toBeGreaterThanOrEqual(13);
  await page.keyboard.press("Tab");
  await expect
    .poll(() =>
      activityDialog.evaluate((dialog) =>
        dialog.contains(document.activeElement),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(activityDialog).toHaveCount(0);
  await expect(activity).toBeFocused();
  await page.getByRole("button", { name: "Open world details" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "World details" })
      .getByText(/individual tiles do not carry proofs/),
  ).toBeVisible();
});

test("keeps world controls and details usable on a tablet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
  await expect(page.getByLabel("World controls")).toBeVisible();
  await expect(page.getByLabel("World minimap")).toBeVisible();
  await page.getByRole("button", { name: "Open world details" }).click();
  const dialog = page.getByRole("dialog", { name: "World details" });
  await expect(dialog).toBeVisible();
  await expect
    .poll(async () => {
      const current = await dialog.boundingBox();
      return current ? current.y + current.height : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(1024);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(768);
  expect(box!.y + box!.height).toBeLessThanOrEqual(1024);
});

test("keeps the old digest visible until newer viewport coverage is ready", async ({
  page,
}) => {
  await page.request.get("/__life-fixture?chain=1&published=0");
  await page.goto("/?x=5000&y=5000&z=0");
  await expect(page.getByText("Displaying older generation 0")).toBeVisible();
  const canvas = page.getByLabel(
    "Pan and zoom the 10,000 by 10,000 cell world",
  );
  const background = await worldBackgroundHash(canvas);
  await expect.poll(() => worldPixelsHash(canvas)).not.toBe(background);
  const oldPixels = await worldPixelsHash(canvas);
  const world = page.getByRole("region", {
    name: "Interactive Game of Life world",
  });
  const liveRegion = page.locator("main > p[aria-live]");
  await world.focus();
  await page.keyboard.press("Enter");
  await expect(liveRegion).toHaveText(/Generation 0, cell 5000, 5000 is dead/);
  await page.request.get("/__life-fixture?published=1&holdCandidate=1");
  await expect(page.getByText("Preparing visualization 1")).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(200);
  expect(await worldPixelsHash(canvas)).toBe(oldPixels);
  await expect(page.locator("aside").getByText("Generation 0")).toBeVisible();
  await expect(page.getByText("Displaying older generation 0")).toHaveCount(0);
  const candidateRequests = page.waitForResponse(
    (response) =>
      response.url().includes(`0x${"dd".repeat(32)}/tiles/`) && response.ok(),
  );
  await page.request.get("/__life-fixture?releaseCandidate=1");
  await candidateRequests;
  await expect(page.getByText("Ready · generation 1")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Visualized generation 1.")).toBeAttached();
  await expect.poll(() => worldPixelsHash(canvas)).not.toBe(oldPixels);
  await world.focus();
  await page.keyboard.press("Enter");
  await expect(liveRegion).toHaveText(/Generation 1, cell 5000, 5000 is live/);
});

test("invalidates metadata-observation candidate when chain advances while staging", async ({
  page,
}) => {
  await page.request.get("/__life-fixture?chain=1&published=0");
  await page.goto("/?x=5000&y=5000&z=0");
  await expect(page.getByText("Displaying older generation 0")).toBeVisible();
  await page.request.get(
    "/__life-fixture?published=1&evidence=metadata&holdCandidate=1",
  );
  await expect(page.getByText("Preparing visualization 1")).toBeVisible();
  await page.request.get("/__life-fixture?chain=2");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.locator("aside").getByText("Generation 2", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page
      .getByText(/metadata observation does not describe current chain state/i)
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Displaying older generation 0")).toBeVisible();
  await page.request.get("/__life-fixture?releaseCandidate=1");
  await page.waitForTimeout(500);
  await expect(page.getByText(/Ready · generation 1/)).toHaveCount(0);
  await expect(page.locator("aside").getByText("Generation 0")).toBeVisible();
});

test("stale status degrades health without invalidating static artifacts", async ({
  page,
}) => {
  await page.request.get("/__life-fixture?stale=1");
  await page.goto("/");
  await expect(page.getByText("Indexer status stale").first()).toBeVisible();
  await expect(
    page.getByLabel("Pan and zoom the 10,000 by 10,000 cell world"),
  ).toBeVisible();
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
});

test("an unavailable status endpoint preserves the verified world", async ({
  page,
}) => {
  await page.request.get("/__life-fixture?status=unavailable");
  await page.goto("/");
  await expect(
    page.getByText("Indexer status unavailable").first(),
  ).toBeVisible();
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
  await expect(
    page.getByLabel("Pan and zoom the 10,000 by 10,000 cell world"),
  ).toBeVisible();
});

test("latest endpoint failure retains an owned immutable snapshot", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
  await page.request.get("/__life-fixture?latest=unavailable");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.getByText(/Indexer request failed/).first()).toBeVisible();
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
});

test("RPC loss retains the last verified chain and visualization", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
  await page.route("**/groundhog-rpc", (route) => route.abort("failed"));
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.getByText(/failed to fetch/i).first()).toBeVisible();
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Activity", exact: true })
      .getByText("Generation 0", { exact: true })
      .first(),
  ).toBeVisible();
});

test("a malformed status remains distinct from endpoint unavailability", async ({
  page,
}) => {
  await page.request.get("/__life-fixture?status=malformed");
  await page.goto("/");
  await expect(
    page.getByText("Indexer status malformed").first(),
  ).toBeVisible();
  await expect(page.getByText("Indexer status unavailable")).toHaveCount(0);
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
});

test("reduced motion uses the same candidate coverage gate", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.request.get("/__life-fixture?chain=1&published=0");
  await page.goto("/?x=5000&y=5000&z=0");
  await expect(page.getByText("Displaying older generation 0")).toBeVisible();
  const canvas = page.getByLabel(
    "Pan and zoom the 10,000 by 10,000 cell world",
  );
  const background = await worldBackgroundHash(canvas);
  await expect.poll(() => worldPixelsHash(canvas)).not.toBe(background);
  const oldPixels = await worldPixelsHash(canvas);
  await page.request.get("/__life-fixture?published=1&holdCandidate=1");
  await expect(page.getByText("Preparing visualization 1")).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(150);
  expect(await worldPixelsHash(canvas)).toBe(oldPixels);
  await page.request.get("/__life-fixture?releaseCandidate=1");
  await expect(page.getByText("Ready · generation 1")).toBeVisible({
    timeout: 10_000,
  });
  await expect.poll(() => worldPixelsHash(canvas)).not.toBe(oldPixels);
});

test("keeps the world and required controls usable in mobile landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 320 });
  await page.goto("/");
  await page.addStyleTag({
    content:
      ":root { --safe-top: 9px; --safe-right: 21px; --safe-bottom: 15px; --safe-left: 7px; }",
  });
  await expect(
    page.getByLabel("Pan and zoom the 10,000 by 10,000 cell world"),
  ).toBeVisible();
  await expect(page.getByLabel("World controls")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open activity" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open world details" }).click();
  const dialog = page.getByRole("dialog", { name: "World details" });
  await expect(dialog).toBeVisible();
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box ? box.y + box.height : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(320);
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(320);
  const landscapeTargets = await assertVisibleTargetsFit(page, 640, 320);
  expect(landscapeTargets).toContain("Close sheet");
  await assertElementsFit(page, 640, 320, [
    page.locator("header"),
    dialog,
    dialog.getByRole("button", { name: "Close sheet" }),
  ]);
  const landscapeClose = await dialog
    .getByRole("button", { name: "Close sheet" })
    .boundingBox();
  expect(landscapeClose).not.toBeNull();
  expect(landscapeClose!.x + landscapeClose!.width).toBeLessThanOrEqual(619);
  expect(landscapeClose!.y).toBeGreaterThanOrEqual(9);
});

async function assertVisibleTargetsFit(
  page: import("@playwright/test").Page,
  width: number,
  height: number,
) {
  const boxes = (
    await page.locator("button:visible, a:visible").evaluateAll((targets) =>
      targets.flatMap((target) => {
        const box = target.getBoundingClientRect();
        const topmost = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        return topmost && (topmost === target || target.contains(topmost))
          ? [
              {
                name:
                  target.getAttribute("aria-label") ?? target.textContent ?? "",
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
              },
            ]
          : [];
      }),
    )
  ).filter((box) => box.width > 0 && box.height > 0);
  for (const box of boxes) {
    expect(box.x, box.name).toBeGreaterThanOrEqual(0);
    expect(box.y, box.name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, box.name).toBeLessThanOrEqual(width);
    expect(box.y + box.height, box.name).toBeLessThanOrEqual(height);
  }
  for (let left = 0; left < boxes.length; left += 1)
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const overlaps =
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y;
      expect(overlaps, `${a.name} overlaps ${b.name}`).toBe(false);
    }
  return boxes.map((box) => box.name.trim());
}

async function assertReadoutDoesNotOverlapTriggers(
  page: import("@playwright/test").Page,
) {
  const readout = await page.getByText(/Ready · generation/).boundingBox();
  const activity = await page
    .getByRole("button", { name: "Open activity" })
    .boundingBox();
  expect(readout).not.toBeNull();
  expect(activity).not.toBeNull();
  expect(readout!.x + readout!.width).toBeLessThanOrEqual(activity!.x);
}

async function assertElementsFit(
  page: import("@playwright/test").Page,
  width: number,
  height: number,
  locators: readonly import("@playwright/test").Locator[],
) {
  for (const locator of locators) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    width,
  );
}

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
  const initialTile = page.waitForResponse(
    (response) => response.url().includes("/tiles/") && response.ok(),
  );
  await page.goto("/");
  await initialTile;
  await expect(page.getByText("Ready · generation 0")).toBeVisible();
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
