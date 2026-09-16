import assert from "node:assert/strict";

export async function connect(page) {
  const button = page.getByRole("button", {
    name: "Connect Thruput Wallet",
    exact: true,
  });
  await page.getByRole("button", { name: /^Connect / }).waitFor();
  const picker = page.getByLabel("Wallet provider", { exact: true });
  if (await picker.count())
    await picker.selectOption({ label: "Thruput Wallet" });
  await button.click();
  if (
    await page
      .getByRole("region", { name: "Wallet connection", exact: true })
      .count()
  ) {
    await page.getByRole("button", { name: "Disconnect", exact: true }).waitFor();
  } else {
    await button.waitFor({ state: "detached", timeout: 120000 });
  }
}

// Drive actual extension popups. The scenario chooses rejections and checks
// asynchronous popup errors alongside its app/chain assertions.
export function handleApprovals(
  context,
  { extensionUrl, origins, account, record },
) {
  let rejectNext = false;
  let nextAccount;
  let signaturesBeforeTimeout;
  let failure;
  context.on("page", (page) => {
    void (async () => {
      await page
        .waitForURL((url) => url.searchParams.has("approval"), {
          timeout: 1000,
        })
        .catch(() => {});
      if (
        !page.url().startsWith(extensionUrl) ||
        !page.url().includes("approval=")
      )
        return;
      await page.locator(".origin").waitFor();
      const origin = await page.locator(".origin").evaluate((element) =>
        [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join("")
          .trim(),
      );
      assert.ok(origins.includes(origin), "Unexpected approval origin");
      const reject = rejectNext;
      rejectNext = false;
      const signing = await page
        .getByRole("heading", { name: "Approve a signature?" })
        .count();
      if (!signing && nextAccount) {
        const selected = nextAccount;
        nextAccount = undefined;
        for (const checkbox of await page.getByRole("checkbox").all())
          await checkbox.uncheck();
        await page.getByRole("checkbox", { name: new RegExp(selected) }).check();
      }
      if (signing)
        await page
          .locator(".review")
          .getByText(account(), { exact: true })
          .waitFor();
      record({
        origin,
        kind: signing ? "signature" : "connection",
        rejected: reject,
      });
      if (signing && signaturesBeforeTimeout !== undefined) {
        if (signaturesBeforeTimeout === 0) {
          signaturesBeforeTimeout = undefined;
          return; // Let the real extension approval deadline expire.
        }
        signaturesBeforeTimeout--;
      }
      await page
        .getByRole("button", {
          name: reject ? "Reject" : signing ? "Sign only" : "Connect",
          exact: true,
        })
        .click()
        .catch((error) => {
          // The popup closes during dispatch; scenario assertions verify its effect.
          if (!page.isClosed()) throw error;
        });
    })().catch((error) => {
      failure = error;
    });
  });
  return {
    timeoutSignatureAfter(count = 0) {
      signaturesBeforeTimeout = count;
    },
    rejectNext() {
      rejectNext = true;
    },
    selectAccountNext(address) {
      nextAccount = address;
    },
    check() {
      if (failure) throw failure;
    },
  };
}
