import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { clientIpKey, normalizeIp } from "./ip";

const request = (
  headers: Record<string, string>,
  remoteAddress = "127.0.0.1",
) => ({ headers, socket: { remoteAddress } }) as IncomingMessage;
describe("client IP identity", () => {
  it("ignores spoofed proxy headers on direct local requests", () => {
    expect(
      clientIpKey(
        request({
          "x-forwarded-for": "1.2.3.4",
          "x-faucet-client-ip": "1.2.3.4",
        }),
        null,
        "salt",
      ),
    ).toBe(clientIpKey(request({}), null, "salt"));
  });
  it("requires the gateway secret before trusting its client address", () => {
    expect(() =>
      clientIpKey(
        request({ "x-faucet-client-ip": "1.2.3.4" }),
        "secret",
        "salt",
      ),
    ).toThrow();
    expect(() =>
      clientIpKey(
        request({
          "x-faucet-proxy-key": "secret",
          "x-faucet-client-ip": "1.2.3.4, 5.6.7.8",
        }),
        "secret",
        "salt",
      ),
    ).toThrow();
    const key = clientIpKey(
      request({
        "x-faucet-proxy-key": "secret",
        "x-faucet-client-ip": "1.2.3.4",
      }),
      "secret",
      "salt",
    );
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("1.2.3.4");
  });
  it("normalizes equivalent IPv6 and mapped IPv4, grouping IPv6 /64", () => {
    expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeIp("0:0:0:0:0:ffff:c000:201")).toBe("192.0.2.1");
    expect(normalizeIp("2001:db8:1:2::1234")).toBe(
      normalizeIp("2001:0db8:0001:2::abcd"),
    );
    expect(normalizeIp("2001:db8:1:3::1234")).not.toBe(
      normalizeIp("2001:db8:1:2::1234"),
    );
  });
});
