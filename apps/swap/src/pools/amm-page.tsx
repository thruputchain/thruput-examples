import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

export function AmmPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="isolate min-h-svh bg-background text-foreground antialiased">
      <header className="border-b border-foreground/10">
        <div className="mx-auto flex min-h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link className="font-heading font-semibold tracking-tight" to="/pools">
            Groundhog AMM
          </Link>
          <nav aria-label="Main navigation" className="flex items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <Link to="/pools">Pools</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/pools/new">Create pool</Link>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex max-w-2xl flex-col gap-2">
            <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              {title}
            </h1>
            <p className="text-muted-foreground">{description}</p>
          </div>
          {actions}
        </div>
        {children}
      </main>
    </div>
  );
}
