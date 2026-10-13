import { seed } from "../../../scripts/seed/seed.ts";

seed("tokens").catch(() => {
  // RPC errors may contain signed payloads. The runner reports safe step context.
  console.error(
    "Token seeding stopped. Check the printed steps and hashes before starting a fresh run.",
  );
  process.exitCode = 1;
});
