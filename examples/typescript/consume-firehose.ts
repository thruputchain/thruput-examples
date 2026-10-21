// Run with: npm run example:consume-firehose
// Uses only Node built-ins, no SDK package: the firehose is a separate service
// from the JSON-RPC gateway.
// One process per OUTPUT_DIR. Saved records are output, not commitment verification.
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const url = process.env.FIREHOSE_URL ?? "wss://firehose.thruput.network";
const directory = resolve(process.env.OUTPUT_DIR ?? "./firehose-output");
await mkdir(directory, { recursive: true });
const checkpoint = join(directory, "cursor.json");
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Expected a nonnegative safe integer");
  }
  return value;
}
let next: number | undefined;
try {
  const saved = JSON.parse(await readFile(checkpoint, "utf8"));
  if (saved.url !== url)
    throw new Error("Checkpoint endpoint differs from FIREHOSE_URL");
  next = integer(saved.nextHeight);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
async function durable(name: string, bytes: string | Uint8Array) {
  const destination = join(directory, name);
  const file = await open(destination + ".tmp", "w");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(destination + ".tmp", destination);
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
async function save(height: number) {
  await durable("cursor.json", JSON.stringify({ url, nextHeight: height }));
  next = height;
}
class Fatal extends Error {}
class Retry extends Error {}
async function consume() {
  const ws = new WebSocket(url);
  let requestId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let finish!: (error: Error) => void;
  const done = new Promise<Error>((resolve) => {
    finish = resolve;
  });
  let stopped = false;
  function stop(error: Error) {
    if (stopped) return;
    stopped = true;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
    finish(error);
  }
  function rpc(method: string, params: unknown[]): Promise<unknown> {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => stop(new Retry(method + " timed out")),
        15000,
      );
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  let processing = Promise.resolve();
  ws.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      const call = pending.get(message.id);
      if (call) {
        clearTimeout(call.timer);
        pending.delete(message.id);
        if (message.error) {
          call.reject(new Fatal(JSON.stringify(message.error)));
        } else call.resolve(message.result);
        return;
      }
      if (message.method !== "firehose_block") return;
      const result = message.params.result;
      if (result.type === "closed") {
        stop(new Fatal("Subscription closed: " + JSON.stringify(result)));
        return;
      }
      if (result.type !== "block") throw new Fatal("Unknown notification type");
      processing = processing
        .then(async () => {
          if (stopped) return;
          const block = result.block;
          const height = integer(block.height);
          const subscriberId = integer(result.subscriberId);
          if (next !== undefined && height !== next)
            throw new Fatal("Unexpected height");
          if (
            typeof block.record !== "string" ||
            !/^0x(?:[0-9a-fA-F]{2})*$/.test(block.record)
          ) {
            throw new Fatal("Invalid record hex");
          }
          const bytes = Buffer.from(block.record.slice(2), "hex");
          if (bytes.length !== integer(block.byteLength))
            throw new Fatal("Byte length mismatch");
          // Before work, retain this inclusive replay height for uncertain ACKs.
          await save(height);
          // Idempotent output: replay overwrites the same height, never appends twice.
          await durable(height + ".xdr", bytes);
          if (stopped) return;
          await rpc("firehose_ack", [subscriberId, height]);
          await save(integer(height + 1));
          console.log(JSON.stringify({ height, bytes: bytes.length }));
        })
        .catch((error) =>
          stop(
            error instanceof Retry || error instanceof Fatal
              ? error
              : new Fatal(String(error)),
          ),
        );
    } catch (error) {
      stop(new Fatal(String(error)));
    }
  });
  ws.addEventListener("error", () => stop(new Retry("WebSocket error")));
  ws.addEventListener("close", () => stop(new Retry("WebSocket closed")));
  try {
    const opened = await Promise.race([
      new Promise<undefined>((resolve) =>
        ws.addEventListener("open", () => resolve(undefined), { once: true }),
      ),
      done,
    ]);
    if (opened instanceof Error) throw opened;
    const cursor =
      next === undefined ? { from: "tip" } : { from: "height", height: next };
    await rpc("firehose_subscribe", [cursor]);
    throw await done;
  } finally {
    stop(new Error("Consumer stopped"));
    ws.close();
    await processing;
  }
}
for (;;) {
  try {
    await consume();
  } catch (error) {
    if (error instanceof Fatal) {
      console.error(error.message);
      console.error(
        "Stopped. For below_window, recover state or explicitly start a new output directory at tip.",
      );
      process.exitCode = 1;
      break;
    }
    console.error(
      String(error) + "; reconnecting in 2 seconds from saved progress",
    );
    await delay(2000);
  }
}
