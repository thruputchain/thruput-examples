import assert from "node:assert/strict";

// Exercise the actual auto-sized toolbar popup, not an extension page in a tab.
// Playwright does not expose this popup as a Page; use its same-origin view.
export async function checkPopupStability(control) {
  await control.evaluate(() => chrome.action.openPopup());
  const result = await control.evaluate(async () => {
    const popup = chrome.extension.getViews({ type: "popup" })[0];
    if (!popup) throw new Error("Toolbar popup did not open");
    const reads = { state: 0, portfolio: 0 };
    const sendMessage = popup.chrome.runtime.sendMessage.bind(popup.chrome.runtime);
    popup.chrome.runtime.sendMessage = (...args) => {
      const message = args[0];
      if (message?.kind === "ui" && Object.hasOwn(reads, message.op))
        reads[message.op]++;
      return sendMessage(...args);
    };
    let timer;
    try {
      const deadline = Date.now() + 5000;
      while (!popup.document.querySelector("#account option")) {
        if (Date.now() >= deadline) throw new Error("Popup accounts did not load");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await popup.document.fonts.ready;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const accountSelect = popup.document.querySelector("#account");
      const options = accountSelect.innerHTML;
      const widths = new Set();
      const bodyWidths = new Set();
      let accountChanges = 0;
      timer = setInterval(() => {
        widths.add(popup.innerWidth);
        bodyWidths.add(popup.document.body.getBoundingClientRect().width);
        if (
          popup.document.querySelector("#account") !== accountSelect ||
          accountSelect.innerHTML !== options
        ) accountChanges++;
      }, 16);
      // Include a normal 10-second state poll while the popup is open.
      await new Promise((resolve) => setTimeout(resolve, 11000));
      return {
        widths: [...widths], bodyWidths: [...bodyWidths], accountChanges, reads,
      };
    } finally {
      clearInterval(timer);
      popup.close();
    }
  });
  assert.equal(result.widths.length, 1, "Toolbar popup width must remain stable");
  assert.deepEqual(result.bodyWidths, [400]);
  assert.equal(result.accountChanges, 0, "State polling must retain the account dropdown");
  assert.ok(result.reads.state >= 1 && result.reads.state <= 2,
    `Unexpected state polling rate: ${result.reads.state}`);
  assert.ok(result.reads.portfolio <= 1,
    `Unchanged accounts must not refetch the portfolio: ${result.reads.portfolio}`);
}
