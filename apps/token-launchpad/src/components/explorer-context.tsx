import { createContext, use, type ReactNode } from "react";
import { parseExplorerUrl } from "@/lib/explorer-url";

const ExplorerContext = createContext<string | null>(null);

export function ExplorerProvider({
  value,
  children,
}: {
  value: string | undefined;
  children: ReactNode;
}) {
  let origin: string | null = null;
  try {
    origin = parseExplorerUrl(value);
  } catch {
    // Supplied configs must not turn malformed origins into navigation targets.
  }
  return <ExplorerContext value={origin}>{children}</ExplorerContext>;
}

export function useExplorerUrl(): string | null {
  return use(ExplorerContext);
}
