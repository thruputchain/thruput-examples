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
import type { DevelopmentPersona, DevelopmentPersonaId } from "@/development-personas";

interface DevelopmentWalletContextValue {
  active: DevelopmentPersona;
  personas: readonly DevelopmentPersona[];
  isSwitching: boolean;
  switchError: string | null;
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
        >
          <UserRoundIcon data-icon="inline-start" />
          {wallet.isSwitching ? "Switching..." : wallet.active.label}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Development wallet</PopoverTitle>
          <PopoverDescription>
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
                <span className="text-xs text-muted-foreground">{persona.description}</span>
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
      </PopoverContent>
    </Popover>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}
