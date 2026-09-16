import type {
  WalletProvider,
  WalletSession,
  ProviderRequest,
} from "@groundhogchain/client/provider";
if (window === window.top && ["http:", "https:"].includes(location.protocol)) {
  const listeners = new Set<(session: WalletSession) => void>();
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== "groundhog:extension:reply"
    )
      return;
    const data = event.data;
    if (data.change) {
      for (const listener of listeners) {
        try {
          listener(data.change);
        } catch {
          /* A page listener must not prevent other listeners. */
        }
      }
      return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(data.id);
    if (data.error)
      request.reject(
        Object.assign(new Error(data.error.message), { code: data.error.code }),
      );
    else request.resolve(data.result);
  });
  const provider: WalletProvider = Object.freeze({
    supportedMethods: Object.freeze(["getCapabilities"] as const),
    info: Object.freeze({
      id: "dev.groundhog.wallet",
      name: "Thruput Wallet",
      version: "1.0.0" as const,
    }),
    request(request: ProviderRequest): Promise<unknown> {
      if (pending.size >= 16)
        return Promise.reject(
          Object.assign(new Error("Too many pending requests"), {
            code: -32002,
          }),
        );
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          window.postMessage(
            { channel: "groundhog:extension:request", id, cancel: true },
            location.origin,
          );
          reject(
            Object.assign(new Error("Wallet request timed out"), {
              code: 4001,
            }),
          );
        }, 120000);
        pending.set(id, { resolve, reject, timer });
        window.postMessage(
          { channel: "groundhog:extension:request", id, request },
          location.origin,
        );
      });
    },
    on(event: "change", listener: (session: WalletSession) => void) {
      if (event === "change") listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("groundhog:announceProvider", { detail: provider }),
    );
  window.addEventListener("groundhog:requestProvider", announce);
  announce();
}
