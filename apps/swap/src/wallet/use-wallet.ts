import { createContext, useContext } from "react";
import type {
  WalletProvider,
  WalletSession,
} from "@groundhogchain/client/provider";

export interface WalletState {
  providers: WalletProvider[];
  provider: WalletProvider | null;
  session: WalletSession | null;
  address: string | null;
  busy: boolean;
  error: string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  selectProvider(id: string): void;
  selectAccount(address: string): void;
}
export const WalletContext = createContext<WalletState | null>(null);
export const useWallet = () => useContext(WalletContext);
