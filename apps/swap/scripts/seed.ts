import { seed } from "../../../scripts/seed/seed.ts";

seed("pools").catch(() => {
  console.error(
    "Pool seeding stopped. Correct the prerequisite or failed step and rerun the same command.",
  );
  process.exitCode = 1;
});
