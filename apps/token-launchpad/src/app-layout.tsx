import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useWallet } from "@thruputchain/react";
import { AppHeader } from "@/components/app-header";
import { WalletControls, WalletInstallBanner } from "@/wallet/wallet-controls";

export function AppLayout({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const location = useLocation();
  const readOnly = wallet.status !== "connected";
  return (
    <div className="isolate min-h-svh bg-background text-foreground antialiased">
      <WalletInstallBanner />
      <AppHeader
        product="Token Launchpad"
        navigationKey={location.key}
        homeHref={readOnly ? "/tokens" : "/create"}
        navigation={
          <>
            <NavLink className="app-nav-link" to="/tokens">
              Tokens
            </NavLink>
            <NavLink className="app-nav-link" to="/my-tokens">
              My Tokens
            </NavLink>
            <NavLink className="app-nav-link" to="/create">
              Create Token
            </NavLink>
          </>
        }
        actions={<WalletControls />}
      />
      {children}
    </div>
  );
}
