import { NavLink } from "react-router-dom";

import { AppHeader } from "@/components/app-header";
import { WalletControls } from "@/wallet/connected-app";

export function AmmPage({
  title,
  description,
  actions,
  children,
  readOnly = false,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  readOnly?: boolean;
}) {
  return (
    <div className="isolate min-h-svh bg-background text-foreground antialiased">
      <AppHeader
        product="Swap"
        homeHref="/pools"
        navigation={
          <>
            <NavLink className="app-nav-link" to="/pools" end>
              Pools
            </NavLink>
            {readOnly ? null : (
              <NavLink className="app-nav-link" to="/pools/new">
                Create Pool
              </NavLink>
            )}
          </>
        }
        actions={
          <>
            {actions}
            <WalletControls />
          </>
        }
      />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
        <div className="flex max-w-2xl flex-col gap-2">
          <h1 className="app-page-title">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        {children}
      </main>
    </div>
  );
}
