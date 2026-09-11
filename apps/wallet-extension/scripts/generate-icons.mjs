import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";

// Render the shared Thruput favicon mark into Chrome's required PNG sizes.
// Requires librsvg's rsvg-convert; generated PNGs are checked in.
const publicDir = new URL("../public/", import.meta.url);
await mkdir(new URL("icons/", publicDir), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  execFileSync("rsvg-convert", [
    "--width",
    String(size),
    "--height",
    String(size),
    "--output",
    new URL(`icons/icon-${size}.png`, publicDir).pathname,
    new URL("favicon.svg", publicDir).pathname,
  ]);
}
