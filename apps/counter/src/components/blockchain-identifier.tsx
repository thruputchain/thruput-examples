export function BlockchainIdentifier({
  value,
  kind,
  explorerUrl,
}: {
  value: string;
  kind: "tx" | "address";
  explorerUrl: string | null;
}) {
  const short = `${value.slice(0, 8)}…${value.slice(-4)}`;
  return explorerUrl ? (
    <a
      href={`${explorerUrl}/${kind}/${value}`}
      target="_blank"
      rel="noopener noreferrer"
      title={value}
      aria-label={`${kind === "tx" ? "Transaction" : "Contract"} ${value} (opens in new tab)`}
      className="font-mono underline decoration-border underline-offset-4 hover:text-primary"
    >
      {short} <span aria-hidden="true">↗</span>
    </a>
  ) : (
    <span title={value} className="font-mono">
      {short}
    </span>
  );
}
