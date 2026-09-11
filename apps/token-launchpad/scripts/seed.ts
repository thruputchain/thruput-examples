import { seed } from "../../../scripts/seed/seed.ts";

seed("tokens").catch(() => {
  // RPC errors may contain signed payloads. The runner reports safe step context.
  console.error(
    "Token seeding stopped. Correct the prerequisite or failed step and rerun the same command.",
  );
  process.exitCode = 1;
});
