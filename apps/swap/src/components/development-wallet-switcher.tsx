import { CheckIcon, ChevronDownIcon, UserRoundIcon } from "lucide-react";
import { createContext, use, useState } from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { WalletPortfolio } from "@/components/wallet-portfolio";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  DevelopmentPersonaId,
  PublicDevelopmentPersona,
} from "@/development-personas";
import type { WalletPortfolioReader } from "@/wallet/portfolio";

interface DevelopmentWalletContextValue {
  active: PublicDevelopmentPersona;
  personas: readonly PublicDevelopmentPersona[];
  isSwitching: boolean;
  switchError: string | null;
  readPortfolio: WalletPortfolioReader;
  switchTo: (id: DevelopmentPersonaId) => Promise<void>;
}

export const DevelopmentWalletContext = createContext<DevelopmentWalletContextValue | null>(null);

export function DevelopmentWalletSwitcher() {
  const wallet = use(DevelopmentWalletContext);
  const [open, setOpen] = useState(false);
  if (wallet === null) return null;
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
        className="max-h-[min(38rem,var(--radix-popover-content-available-height))] w-88 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <PopoverHeader>
          <PopoverTitle>Development wallet</PopoverTitle>
          <PopoverDescription role={wallet.switchError === null ? undefined : "alert"}>
            {wallet.switchError
              ?? "Switch this tab's disposable local account."}
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-1">
          {wallet.personas.map((persona) => (
            <Button
              className="h-auto justify-start px-3 py-2 text-left"
              disabled={wallet.isSwitching}
              key={persona.id}
              onClick={() => select(persona.id)}
              variant="ghost"
            >
              <span className="flex min-w-0 flex-1 flex-col items-start">
                <span className="font-medium">{persona.label}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {shortAddress(persona.accountAddressHex)}
                </span>
              </span>
              {persona.id === wallet.active.id ? (
                <CheckIcon aria-label="Active wallet" data-icon="inline-end" />
              ) : null}
            </Button>
          ))}
        </div>
        <Separator />
        <WalletPortfolio read={wallet.readPortfolio} />
      </PopoverContent>
    </Popover>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}
