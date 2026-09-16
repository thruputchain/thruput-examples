import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Keep a filesystem lock for this process; the OS releases it even after SIGKILL. */
export function acquireStateLock(
  directory: string,
  owner = "faucet server",
): () => void {
  const database = new DatabaseSync(join(directory, "server-lock.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (error) {
    database.close();
    if (error instanceof Error && "errcode" in error && error.errcode === 5) {
      throw new Error(
        `Another ${owner} is using this state directory. Stop it before starting another.`,
        { cause: error },
      );
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    database.close();
    released = true;
  };
}
