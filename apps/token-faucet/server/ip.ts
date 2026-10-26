import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/** IPv4-mapped IPv6 shares its IPv4 limit. Other IPv6 addresses share a /64. */
export function normalizeIp(value: string): string {
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) throw new Error("Invalid client IP.");
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const [left = "", right] = canonical.split("::");
  const first = left ? left.split(":") : [];
  const last = right ? right.split(":") : [];
  const groups =
    right === undefined
      ? first
      : [
          ...first,
          ...Array<string>(8 - first.length - last.length).fill("0"),
          ...last,
        ];
  const words = groups.map((word) => Number.parseInt(word, 16));
  if (words.slice(0, 5).every((n) => n === 0) && words[5] === 0xffff)
    return `${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`;
  return `${words
    .slice(0, 4)
    .map((n) => n.toString(16))
    .join(":")}::/64`;
}

export function clientIpKey(
  request: IncomingMessage,
  proxySecret: string | null,
  salt: string,
): string {
  let ip = request.socket.remoteAddress ?? "";
  if (proxySecret) {
    const supplied = request.headers["x-faucet-proxy-key"];
    if (
      typeof supplied !== "string" ||
      supplied.length !== proxySecret.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(proxySecret))
    )
      throw new Error("Use the examples gateway.");
    const forwarded = request.headers["x-faucet-client-ip"];
    if (typeof forwarded !== "string")
      throw new Error("Missing gateway client IP.");
    ip = forwarded;
  }
  return createHmac("sha256", salt).update(normalizeIp(ip)).digest("hex");
}
