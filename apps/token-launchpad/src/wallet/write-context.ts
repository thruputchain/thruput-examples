import { createContext, useContext } from "react";
import {
  unavailableWriteBoundary,
  type WriteBoundary,
} from "@/transactions/write-boundary";

export const WalletWriteContext = createContext<WriteBoundary>(
  unavailableWriteBoundary,
);
export const useWalletWriteBoundary = () => useContext(WalletWriteContext);
