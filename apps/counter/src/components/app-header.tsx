import { ZapIcon } from "lucide-react";

export function AppHeader({ ready }: { ready: boolean }) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex min-h-20 max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:min-h-22">
        <a
          href="/"
          aria-label="Thruput Counter homepage"
          className="flex min-h-12 shrink-0 items-center gap-2.5"
        >
          <ZapIcon
            className="size-6 shrink-0 fill-primary stroke-primary"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
            <div className="text-xl font-medium tracking-tight">THRUPUT</div>
            <div className="font-mono text-xs text-muted-foreground sm:border-l sm:pl-3">
              Counter
            </div>
          </div>
        </a>
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${ready ? "bg-local" : "bg-muted-foreground"}`}
          />
          <span>{ready ? "Connected" : "Not ready"}</span>
        </div>
      </div>
    </header>
  );
}
