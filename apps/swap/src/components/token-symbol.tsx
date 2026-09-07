import { BlockchainIdentifier } from "./blockchain-identifier";

// Older persisted creation workflows used shortened addresses as symbols.
// Match only this token's known fallback, never scan messages or error strings.
export function TokenSymbol({
  symbol,
  address,
  nonInteractive = false,
}: {
  symbol: string;
  address: string;
  nonInteractive?: boolean;
}) {
  const fallback = [
    address,
    `${address.slice(0, 8)}...`,
    `${address.slice(0, 8)}…`,
  ];
  return fallback.some(
    (value) => value.toLowerCase() === symbol.toLowerCase(),
  ) ? (
    <BlockchainIdentifier
      kind="address"
      value={address}
      label="Token address"
      nonInteractive={nonInteractive}
    />
  ) : (
    <>{symbol}</>
  );
}
