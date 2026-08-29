import { createRoot } from "react-dom/client";
import { App } from "./app";
import { ConfigurationError, loadAppConfig } from "./config";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Application root is missing");
const root = createRoot(container);
try {
  const config = loadAppConfig(import.meta.env);
  root.render(<App config={config} />);
} catch (cause) {
  const message =
    cause instanceof ConfigurationError
      ? cause.message
      : "Startup configuration could not be validated";
  root.render(
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <section
        role="alert"
        className="max-w-[52ch] rounded-lg border border-destructive/40 bg-panel p-5"
      >
        <h1 className="text-balance text-xl font-semibold">
          Invalid startup configuration
        </h1>
        <p className="mt-2 text-pretty text-base text-muted-foreground sm:text-sm">
          {message}
        </p>
      </section>
    </main>,
  );
}
