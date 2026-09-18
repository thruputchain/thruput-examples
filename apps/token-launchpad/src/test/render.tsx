import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render as renderReact,
  renderHook as renderReactHook,
  type RenderOptions,
  type RenderHookOptions,
} from "@testing-library/react";
export * from "@testing-library/react";

function Queries({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
export function render(ui: ReactNode, options?: RenderOptions) {
  return renderReact(ui, { wrapper: Queries, ...options });
}
export function renderHook<Result, Props>(
  render: (props: Props) => Result,
  options?: RenderHookOptions<Props>,
) {
  return renderReactHook(render, { wrapper: Queries, ...options });
}
