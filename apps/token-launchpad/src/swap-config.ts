export function loadSwapAppUrl(
  value: string | boolean | undefined,
): string | null {
  if (value === undefined || (typeof value === "string" && value.trim() === ""))
    return null;
  try {
    if (typeof value !== "string") throw new Error();
    const url = new URL(value);
    const authority = /^https?:\/\/([^/?#\\]+)\/?$/i.exec(value);
    const host = authority?.[1]?.replace(/:\d+$/, "").toLowerCase();
    if (
      !authority ||
      /\s/.test(value) ||
      authority[1]!.includes("@") ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(host ?? "")
        ))
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(
      "VITE_SWAP_APP_URL must be an HTTPS root origin or exact loopback HTTP origin without credentials",
    );
  }
}
