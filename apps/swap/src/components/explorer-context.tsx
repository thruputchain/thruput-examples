import { createContext, use, type ReactNode } from "react";
import { ConfigurationError, parseExplorerUrl } from "@/config";

const ExplorerContext = createContext<string | undefined>(undefined);

export function ExplorerProvider({ value, children }: {
  value: string | undefined;
  children: ReactNode;
}) {
  let explorerUrl: string | undefined;
  try {
    explorerUrl = parseExplorerUrl(value);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    // Supplied app config may bypass environment validation. Fail closed.
  }
  return <ExplorerContext value={explorerUrl}>{children}</ExplorerContext>;
}

export function useExplorerUrl(): string | undefined {
  return use(ExplorerContext);
}
