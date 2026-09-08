import {
  render as renderReact,
  type RenderOptions,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

export * from "@testing-library/react";

export function render(ui: ReactNode, options?: RenderOptions) {
  return renderReact(ui, { wrapper: TooltipProvider, ...options });
}
