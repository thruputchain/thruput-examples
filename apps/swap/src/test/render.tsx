import {
  render as renderReact,
  type RenderOptions,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { notifyManager, focusManager } from "@tanstack/react-query";
import { afterEach } from "vitest";
import { AppProviders } from "@/app-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  createGroundhogClient,
  localnet,
  MockTransport,
} from "@groundhogchain/client";

const client = await createGroundhogClient({
  cluster: localnet(),
  transport: new MockTransport(),
});
export { client as testClient };
notifyManager.setScheduler(queueMicrotask);
afterEach(() => focusManager.setFocused(undefined));

export function TestProviders({ children }: { children: ReactNode }) {
  return (
    <AppProviders client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </AppProviders>
  );
}

export * from "@testing-library/react";

export function render(ui: ReactNode, options?: RenderOptions) {
  const { wrapper: Wrapper, ...rest } = options ?? {};
  return renderReact(ui, {
    ...rest,
    wrapper: ({ children }) => (
      <TestProviders>
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </TestProviders>
    ),
  });
}
