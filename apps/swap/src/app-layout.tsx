import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { AppHeader } from "@/components/app-header";
import { WalletControls, WalletInstallBanner } from "@/wallet/wallet-controls";

export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <div className="isolate min-h-svh bg-background text-foreground antialiased">
      <WalletInstallBanner />
      <AppHeader
        product="Swap"
        navigationKey={location.key}
        homeHref="/pools"
        navigation={
          <>
            <NavLink className="app-nav-link" to="/pools" end>
              Pools
            </NavLink>
            <NavLink className="app-nav-link" to="/pools/new">
              Create Pool
            </NavLink>
          </>
        }
        actions={<WalletControls />}
      />
      {children}
    </div>
  );
}
