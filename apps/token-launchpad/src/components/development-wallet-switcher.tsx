import { CheckIcon, ChevronDownIcon, UserRoundIcon } from "lucide-react";
import { createContext, use, useState } from "react";

import { Button } from "@/components/ui/button";
import { BlockchainIdentifier } from "@/components/blockchain-identifier";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { WalletPortfolio } from "@/components/wallet-portfolio";
import type {
  DevelopmentPersonaId,
  PublicDevelopmentPersona,
} from "@/development-personas";
import type { WalletPortfolioReader } from "@/wallet/portfolio";

export const DevelopmentWalletContext = createContext<{
  active: PublicDevelopmentPersona;
  personas: readonly PublicDevelopmentPersona[];
  isSwitching: boolean;
  switchError: string | null;
  readPortfolio: WalletPortfolioReader;
  switchTo: (id: DevelopmentPersonaId) => Promise<void>;
} | null>(null);

export function DevelopmentWalletSwitcher() {
  const wallet = use(DevelopmentWalletContext);
  const [open, setOpen] = useState(false);
  if (!wallet) return null;
  const activeWallet = wallet;
  async function select(id: DevelopmentPersonaId) {
    try {
      if (id !== activeWallet.active.id) await activeWallet.switchTo(id);
    } catch {
      return;
    }
    setOpen(false);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Development wallet: ${wallet.active.label}`}
          disabled={wallet.isSwitching}
          size="sm"
          variant="secondary"
          data-development-wallet-trigger
        >
          <UserRoundIcon data-icon="inline-start" />
          {wallet.isSwitching ? "Switching..." : wallet.active.label}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(38rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <PopoverHeader>
          <PopoverTitle>Development wallet</PopoverTitle>
          <PopoverDescription
            role={wallet.switchError === null ? undefined : "alert"}
          >
            {wallet.switchError ??
              "Switch this tab's disposable local account."}
          </PopoverDescription>
        </PopoverHeader>
        <Separator />
        <div className="flex flex-col gap-1">
          {wallet.personas.map((persona) => (
            <div key={persona.id} className="flex flex-col gap-1">
              <Button
                variant="ghost"
                className="h-auto justify-start px-3 py-2"
                disabled={wallet.isSwitching}
                onClick={() => void select(persona.id)}
              >
                <span className="min-w-0 flex-1 text-left">
                  <span className="block font-medium">{persona.label}</span>
                </span>
                {persona.id === wallet.active.id ? (
                  <CheckIcon aria-label="Active wallet" />
                ) : null}
              </Button>
              <div className="px-3 pb-2 text-muted-foreground">
                <BlockchainIdentifier
                  kind="address"
                  value={persona.accountAddressHex}
                />
              </div>
            </div>
          ))}
        </div>
        <Separator />
        <WalletPortfolio read={wallet.readPortfolio} />
        <Separator />
        <p className="text-xs text-muted-foreground">
          Local development wallet. Do not send real assets.
        </p>
      </PopoverContent>
    </Popover>
  );
}
