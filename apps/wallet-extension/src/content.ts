import { requestSchema } from "./policy";
if (window === window.top && ["http:", "https:"].includes(location.protocol)) {
  const active = new Set<string>();
  const reply = (data: unknown) =>
    window.postMessage(
      { channel: "groundhog:extension:reply", ...(data as object) },
      location.origin,
    );
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== "groundhog:extension:request"
    )
      return;
    const { id, request, cancel } = event.data;
    if (typeof id !== "string" || !/^[\da-f-]{36}$/.test(id)) return;
    if (cancel === true) {
      if (active.has(id))
        void chrome.runtime.sendMessage({ kind: "cancel", id }).catch(() => {});
      return;
    }
    if (active.has(id) || active.size >= 16) return;
    try {
      requestSchema(request);
    } catch {
      reply({ id, error: { code: -32602, message: "Invalid wallet request" } });
      return;
    }
    active.add(id);
    chrome.runtime
      .sendMessage({ kind: "provider", id, request })
      .then(
        (result) => reply({ id, ...result }),
        () =>
          reply({ id, error: { code: 4900, message: "Wallet disconnected" } }),
      )
      .finally(() => active.delete(id));
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.kind === "change") {
      reply({ change: message.session });
      // Queue this window message before the worker may answer connect/disconnect.
      respond(null);
    }
  });
}
