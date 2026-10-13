export function CounterDisplay({
  value,
  stale,
}: {
  value: bigint | null;
  stale: boolean;
}) {
  const text = value?.toLocaleString("en-US") ?? "—";
  return (
    <div className="flex flex-col items-center gap-4 py-6 sm:py-10">
      <p className="font-mono text-sm text-muted-foreground">
        Latest chain value{stale && value !== null ? " · stale" : ""}
      </p>
      <div
        data-testid="counter-value"
        className={`max-w-full break-all text-center font-mono font-medium tracking-tight tabular-nums ${text.length > 14 ? "text-2xl sm:text-4xl" : "text-4xl sm:text-6xl md:text-7xl"}`}
      >
        {text}
      </div>
      <p className="text-base text-muted-foreground sm:text-sm">
        Shared by everyone. Updated from the chain.
      </p>
    </div>
  );
}
