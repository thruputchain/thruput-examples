import { seed } from "../../../scripts/seed/seed.ts";

seed("tokens").catch(() => {
  process.exitCode = 1;
});
