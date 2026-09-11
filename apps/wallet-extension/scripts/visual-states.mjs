import assert from "node:assert/strict";

// Presentation-only fixtures in a separate extension page. No signing, storage,
// or network calls: the real connection flow is tested by browser-acceptance.
export async function captureReviewStates(context, uiUrl, capture) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 680 });
  await page.addInitScript(() => {
    const address = `0x${"12".repeat(32)}`;
    const networkHash = "00".repeat(32);
    const accounts = [{ name: "Preview account", address, index: 0 }];
    const scenario = new URLSearchParams(location.search).get("scenario");
    const state = {
      exists: true,
      unlocked: true,
      network: "localnet",
      networkHash,
      expires: Date.now() + 600000,
      accounts,
      sites: [],
      outgoing:
        scenario === "pending" || scenario === "failed"
          ? [{
              hash: "34".repeat(32),
              account: address,
              network: "localnet",
              networkHash,
              outcome: scenario === "failed" ? "failed" : "unknown",
              createdAt: Date.now(),
            }]
          : [],
    };
    chrome.runtime.sendMessage = async ({ op }) => {
      if (op === "state") return { result: state };
      if (op === "portfolio") {
        if (scenario === "loading") return new Promise(() => {});
        return {
          result: [{
            address: `0x${"0".repeat(63)}1`,
            symbol: "HOG",
            decimals: 7,
            error: "Preview: RPC unavailable",
          }],
        };
      }
      if (op === "approval")
        return {
          result: {
            id: "preview",
            origin: "https://swap.example.test",
            method: "signTransaction",
            networkHash,
            accounts,
            account: address,
            review: {
              method: "execute",
              root: address,
              entrypoint: "0123456789abcdef",
              gas: "1000000",
              expiry: "100",
              nonce: "42",
              calldata: "0x00000000",
              deployments: [],
              calls: [{
                target: `0x${"0".repeat(63)}1`,
                entrypoint: "0123456789abcdef",
                gas: "500000",
                calldata: "0x00000000",
                transfer: {
                  receiver: `0x${"56".repeat(32)}`,
                  amount: "10000000",
                },
              }],
            },
          },
        };
      throw new Error(`Visual fixture does not allow ${op}`);
    };
  });
  try {
    for (const scenario of ["signature", "pending", "failed", "loading"]) {
      await page.goto(
        `${uiUrl}?scenario=${scenario}${scenario === "signature" ? "&approval=preview" : ""}`,
      );
      await page.getByRole("heading", {
        name: scenario === "signature" ? "Approve a signature?" : "Your assets",
      }).waitFor();
      if (scenario === "signature")
        await page.getByText("Not simulated", { exact: true }).waitFor();
      else if (scenario === "loading")
        await page.getByText("Reading balances...").waitFor();
      else await page.getByText("Unavailable", { exact: true }).waitFor();
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(
        await page.locator("button").first().evaluate(
          (el) => getComputedStyle(el).transitionDuration,
        ),
        "0s",
      );
      await capture(page, scenario);
    }
  } finally {
    await page.close();
  }
}
