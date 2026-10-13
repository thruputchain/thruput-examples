import { seed } from "../../../scripts/seed/seed.ts";

seed("pools").catch(() => {
  console.error(
    "Pool seeding stopped. Check the printed steps and hashes before starting a fresh run.",
  );
  process.exitCode = 1;
});
