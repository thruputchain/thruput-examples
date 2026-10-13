import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app";
import { loadRuntimeConfig } from "@/config";
import { createReadClient } from "@/thruput/client";
import { Button } from "@/components/ui/button";
import "@/styles.css";

const root = createRoot(document.getElementById("root")!);
async function start() {
  root.render(
    <main className="p-6" role="status">
      Loading application configuration…
    </main>,
  );
  try {
    const config = await loadRuntimeConfig();
    const client = await createReadClient(config);
    root.render(
      <StrictMode>
        <App config={config} client={client} />
      </StrictMode>,
    );
  } catch (error) {
    root.render(
      <main className="flex flex-col items-start gap-4 p-6">
        <p role="alert">
          {error instanceof Error ? error.message : "Could not start the app"}
        </p>
        <Button onClick={() => void start()}>Try again</Button>
      </main>,
    );
  }
}
void start();
