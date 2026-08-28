import { CheckIcon, ChevronDownIcon, UserRoundIcon } from "lucide-react";
import { createContext, use, useState } from "react";

import { Button } from "@/components/ui/button";
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
  readPortfolio: WalletPortfolioReader;
  switchTo: (id: DevelopmentPersonaId) => void;
} | null>(null);

export function DevelopmentWalletSwitcher() {
  const wallet = use(DevelopmentWalletContext);
  const [open, setOpen] = useState(false);
  if (!wallet) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" data-development-wallet-trigger>
          <UserRoundIcon />
          {wallet.active.label}
          <ChevronDownIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverHeader>
          <PopoverTitle>Development wallet</PopoverTitle>
          <PopoverDescription>
            Switch this tab's disposable local account.
          </PopoverDescription>
        </PopoverHeader>
        <Separator />
        <div className="flex flex-col gap-1">
          {wallet.personas.map((persona) => (
            <Button
              key={persona.id}
              variant="ghost"
              className="h-auto justify-start px-3 py-2"
              onClick={() => {
                wallet.switchTo(persona.id);
                setOpen(false);
              }}
            >
              <span className="min-w-0 flex-1 text-left">
                <span className="block font-medium">{persona.label}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {short(persona.accountAddressHex)}
                </span>
              </span>
              {persona.id === wallet.active.id ? (
                <CheckIcon aria-label="Active wallet" />
              ) : null}
            </Button>
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

function short(value: string): string {
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}
