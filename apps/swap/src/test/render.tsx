import {
  render as renderReact,
  type RenderOptions,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletProvider } from "@groundhogchain/react";
import {
  createGroundhogClient,
  localnet,
  MockTransport,
} from "@groundhogchain/client";

const client = await createGroundhogClient({
  cluster: localnet(),
  transport: new MockTransport(),
});

function Providers({ children }: { children: ReactNode }) {
  return (
    <WalletProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </WalletProvider>
  );
}

export * from "@testing-library/react";

export function render(ui: ReactNode, options?: RenderOptions) {
  const { wrapper: Wrapper, ...rest } = options ?? {};
  return renderReact(ui, {
    ...rest,
    wrapper: ({ children }) => (
      <Providers>
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </Providers>
    ),
  });
}
