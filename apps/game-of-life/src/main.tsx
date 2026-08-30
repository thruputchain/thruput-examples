import { createRoot } from "react-dom/client";
import {
  ConfigurationError,
  loadReadAppConfig,
  type Environment,
} from "./config";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Application root is missing");
const root = createRoot(container);

void renderRoute(window.location.pathname, import.meta.env);

async function renderRoute(pathname: string, environment: Environment) {
  try {
    switch (normalizePath(pathname)) {
      case "/": {
        const { createWorldPage } = await import("./world-bootstrap");
        root.render(createWorldPage(environment));
        return;
      }
      case "/xray": {
        const config = loadReadAppConfig(environment);
        const { XrayPage } = await import("./xray/xray-page");
        root.render(<XrayPage config={config} />);
        return;
      }
      default:
        root.render(<NotFoundPage />);
    }
  } catch (cause) {
    const message =
      cause instanceof ConfigurationError
        ? cause.message
        : "Startup configuration could not be validated";
    root.render(<StartupError message={message} />);
  }
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

function NotFoundPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <section className="flex max-w-[52ch] flex-col gap-4 border-l border-primary/50 py-2 pl-5">
        <p className="font-mono text-base tracking-wide text-primary sm:text-sm">
          ROUTE / NOT FOUND
        </p>
        <h1 className="text-balance text-3xl font-semibold tracking-tight">
          This observation point does not exist.
        </h1>
        <p className="max-w-[52ch] text-pretty text-base text-muted-foreground sm:text-sm">
          Return to the live world or inspect how one generation moves through
          storage.
        </p>
        <nav aria-label="Available pages" className="flex flex-wrap gap-4">
          <a
            href="/"
            className="text-base text-foreground underline decoration-border underline-offset-4 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          >
            Explore world
          </a>
          <a
            href="/xray"
            className="text-base text-foreground underline decoration-border underline-offset-4 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          >
            Transaction X-Ray
          </a>
        </nav>
      </section>
    </main>
  );
}

function StartupError({ message }: { readonly message: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <section
        role="alert"
        className="max-w-[52ch] rounded-lg border border-destructive/40 bg-panel p-5"
      >
        <h1 className="text-balance text-xl font-semibold">
          Invalid startup configuration
        </h1>
        <p className="max-w-[52ch] text-pretty text-base text-muted-foreground sm:text-sm">
          {message}
        </p>
      </section>
    </main>
  );
}
