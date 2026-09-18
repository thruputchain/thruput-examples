import type { ReactNode } from "react";

export function PoolPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex max-w-2xl flex-col gap-2">
        <h1 className="app-page-title">{title}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>
      {children}
    </main>
  );
}
