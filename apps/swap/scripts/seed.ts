import { seed } from "../../../scripts/seed/seed.ts";

seed("pools").catch(() => {
  process.exitCode = 1;
});
