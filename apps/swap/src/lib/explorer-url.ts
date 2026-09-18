import { ConfigurationError } from "./errors";

export function parseExplorerUrl(
  value: string | boolean | undefined,
): string | undefined {
  if (
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return undefined;
  }
  const message =
    "VITE_EXPLORER_URL must be a root HTTPS URL (HTTP is allowed only on exact loopback hosts), without credentials, a query, or a fragment";
  if (typeof value !== "string") throw new ConfigurationError(message);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(message);
  }
  // Check the input too: URL parsing otherwise erases dot paths and empty ?/#.
  if (
    !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/i.test(
          value,
        )
      ))
  ) {
    throw new ConfigurationError(message);
  }
  return url.origin;
}
