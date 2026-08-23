import { createContext, use, useState } from "react";

export type ProcessingMode = "automatic" | "manual";

interface ProcessingModeContextValue {
  mode: ProcessingMode;
  setMode: (mode: ProcessingMode) => void;
}

const ProcessingModeContext = createContext<ProcessingModeContextValue | null>(null);

export function ProcessingModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ProcessingMode>("automatic");
  return (
    <ProcessingModeContext value={{ mode, setMode }}>
      {children}
    </ProcessingModeContext>
  );
}

export function useProcessingMode(): ProcessingModeContextValue {
  const value = use(ProcessingModeContext);
  if (value === null) {
    throw new Error("useProcessingMode must be used within ProcessingModeProvider");
  }
  return value;
}
