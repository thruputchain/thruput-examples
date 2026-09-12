import { createContext, use } from "react";
import { unavailableWriteBoundary } from "@/transactions/write-boundary";

export const WalletWriteContext = createContext(unavailableWriteBoundary);
export const useWalletWriteBoundary = () => use(WalletWriteContext);
