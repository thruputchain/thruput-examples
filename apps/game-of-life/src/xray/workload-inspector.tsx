import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  ETHEREUM_ACCESS_GAS_BLOCK_MULTIPLE,
  ETHEREUM_DIRECT_SLOT_ACCESS_LIST_GAS,
  ETHEREUM_GAS_PER_CELL,
  ETHEREUM_ONE_OPCODE_SCALAR_GAS,
  ETHEREUM_PERSISTENT_SLOT_COUNT,
  ETHEREUM_SCALAR_FLOOR_BLOCK_MULTIPLE,
  ETHEREUM_WRITE_SLOT_COUNT,
  EXECUTION_EVIDENCE,
  formatCount,
  LIFE_WORKLOAD,
  SOLANA_BANK_OVERFLOW_BYTES,
  SOLANA_COMPUTE_UNITS_PER_CELL,
  SOLANA_MIN_ACCOUNTS_PER_BANK,
  SOLANA_SCALAR_FLOOR_MULTIPLE,
} from "./workload";

const SCALE_LEVELS = [
  {
    id: "cell",
    label: "Selected cell",
    value: "1 bit",
    formula: "1 cell × 1 bit = 1 bit",
    detail: "The selected cell occupies one bit inside its packed byte.",
  },
  {
    id: "byte",
    label: "Packed byte",
    value: "8 cells",
    formula: "8 cells ÷ 8 = 1 byte",
    detail: "Eight adjacent horizontal cells share one byte.",
  },
  {
    id: "row",
    label: "One row",
    value: "1,250 bytes",
    formula: "10,000 cells ÷ 8 = 1,250 bytes",
    detail: "A complete row stores 10,000 cells with no padding.",
  },
  {
    id: "bank",
    label: "One bank",
    value: "12.5 MB",
    formula: "10,000 rows × 1,250 bytes = 12,500,000 bytes",
    detail: "One bank materializes every cell in one complete generation.",
  },
  {
    id: "world",
    label: "Persistent world",
    value: "25 MB",
    formula: "2 banks × 12,500,000 bytes = 25,000,000 bytes",
    detail:
      "The current generation and its destination bank persist side by side.",
  },
] as const;

const TICK_PHASES = [
  {
    id: "read",
    step: "01",
    label: "Read source",
    summary:
      "Load the active bank through a rolling three-row window, including two wraparound row rereads.",
    metrics: [
      ["Chunk reads", formatCount(LIFE_WORKLOAD.tickBankChunkReads)],
      ["Bytes read", formatCount(LIFE_WORKLOAD.tickBankReadBytes)],
      ["Rows in window", formatCount(LIFE_WORKLOAD.initialWindowRows)],
      ["Wraparound bytes", formatCount(2 * LIFE_WORKLOAD.rowBytes)],
    ],
  },
  {
    id: "evaluate",
    step: "02",
    label: "Evaluate world",
    summary:
      "Apply the scalar Conway rule to every cell while retaining only the rows needed for the current result.",
    metrics: [
      ["Cell outcomes", formatCount(LIFE_WORKLOAD.ruleEvaluations)],
      ["Rows evaluated", formatCount(LIFE_WORKLOAD.worldHeight)],
      ["Visible working set", "5,000 bytes"],
      ["Destination rows", formatCount(LIFE_WORKLOAD.worldHeight)],
    ],
  },
  {
    id: "write",
    step: "03",
    label: "Write destination",
    summary:
      "Write each completed row into the inactive bank while the active bank remains immutable input.",
    metrics: [
      ["Chunk writes", formatCount(LIFE_WORKLOAD.tickBankChunkWrites)],
      ["Bytes written", formatCount(LIFE_WORKLOAD.tickBankWriteBytes)],
      ["Rows written", formatCount(LIFE_WORKLOAD.worldHeight)],
      ["Destination banks", "1 inactive bank"],
    ],
  },
  {
    id: "commit",
    step: "04",
    label: "Commit together",
    summary:
      "Publish the completed bank and metadata together. Any failure restores the request and discards every write.",
    metrics: [
      ["Population + digest", "1 each"],
      ["Generation + bank switch", "1 each"],
      ["Queue slot + event", "1 each"],
      ["Partial canonical states", "0"],
    ],
  },
] as const;

type ScaleId = (typeof SCALE_LEVELS)[number]["id"];
type TickPhaseId = (typeof TICK_PHASES)[number]["id"];

export function WholeWorldWorkload() {
  const [scaleId, setScaleId] = useState<ScaleId>("cell");
  const [phaseId, setPhaseId] = useState<TickPhaseId>("read");
  const scale = SCALE_LEVELS.find((item) => item.id === scaleId)!;
  const phase = TICK_PHASES.find((item) => item.id === phaseId)!;

  return (
    <section
      className="border-b border-border py-8"
      aria-labelledby="workload-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="font-mono text-base tracking-wide text-primary sm:text-sm">
            WHOLE-WORLD WORKLOAD
          </p>
          <h2
            id="workload-title"
            className="mt-1 text-balance text-2xl font-semibold tracking-tight"
          >
            From one bit to one atomic tick
          </h2>
        </div>
        <p className="max-w-[48ch] text-pretty text-base text-muted-foreground sm:text-sm">
          The same cell operation expands across every stored cell in one
          contract invocation.
        </p>
      </div>

      <div className="grid lg:grid-cols-[2fr_3fr] lg:divide-x lg:divide-border">
        <section className="min-w-0 py-7 lg:pr-8" aria-labelledby="scale-title">
          <p className="font-mono text-base text-warning sm:text-sm">
            STORAGE SCALE
          </p>
          <h3
            id="scale-title"
            className="mt-1 text-balance text-xl font-semibold tracking-tight"
          >
            One selected bit becomes a 25 MB world
          </h3>

          <ol
            role="list"
            aria-label="Storage scale levels"
            className="mt-5 grid divide-y divide-border border-y border-border sm:grid-cols-5 sm:divide-x sm:divide-y-0"
          >
            {SCALE_LEVELS.map((item, index) => {
              const selected = item.id === scaleId;
              return (
                <li key={item.id} className="min-w-0">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setScaleId(item.id)}
                    className={cn(
                      "flex min-h-24 w-full flex-col items-start justify-between gap-2 p-3 text-left outline-none focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring sm:min-h-28",
                      selected ? "bg-muted/40" : "hover:bg-muted/20",
                    )}
                  >
                    <span className="font-mono text-base text-muted-foreground sm:text-sm">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="flex min-w-0 flex-col items-start">
                      <span className="font-medium text-foreground">
                        {item.label}
                      </span>
                      <span className="mt-1 font-mono text-xl text-warning sm:text-lg">
                        {item.value}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="grid gap-2 border-b border-border py-4">
            <p className="text-pretty text-base text-foreground sm:text-sm">
              {scale.detail}
            </p>
            <p className="break-words font-mono text-base text-muted-foreground tabular-nums sm:text-sm">
              {scale.formula}
            </p>
          </div>
          <p aria-live="polite" className="sr-only">
            {scale.detail} {scale.formula}
          </p>
        </section>

        <section
          className="min-w-0 border-t border-border py-7 lg:border-t-0 lg:pl-8"
          aria-labelledby="tick-trace-title"
        >
          <p className="font-mono text-base text-warning sm:text-sm">
            ONE NON-EMPTY TICK
          </p>
          <h3
            id="tick-trace-title"
            className="mt-1 text-balance text-xl font-semibold tracking-tight"
          >
            Step through the fixed transaction workload
          </h3>

          <ol
            role="list"
            aria-label="Atomic tick phases"
            className="mt-5 grid divide-y divide-border border-y border-border sm:grid-cols-4 sm:divide-x sm:divide-y-0"
          >
            {TICK_PHASES.map((item) => {
              const selected = item.id === phaseId;
              return (
                <li key={item.id} className="min-w-0">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setPhaseId(item.id)}
                    className={cn(
                      "flex min-h-20 w-full flex-col items-start justify-center gap-1 p-3 text-left outline-none focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring",
                      selected ? "bg-muted/40" : "hover:bg-muted/20",
                    )}
                  >
                    <span className="font-mono text-base text-muted-foreground sm:text-sm">
                      {item.step}
                    </span>
                    <span className="font-medium text-foreground">
                      {item.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="py-4">
            <p className="max-w-[64ch] text-pretty text-base text-foreground sm:text-sm">
              {phase.summary}
            </p>
            <dl className="mt-4 grid grid-cols-2 border-y border-border font-mono tabular-nums">
              {phase.metrics.map(([label, value], index) => (
                <div
                  key={label}
                  className={cn(
                    "min-w-0 py-3",
                    index % 2 === 0 ? "pr-3" : "border-l border-border pl-3",
                    index > 1 && "border-t border-border",
                  )}
                >
                  <dt className="break-words font-medium text-foreground">
                    {label}
                  </dt>
                  <dd className="mt-1 break-words text-lg text-warning sm:text-base">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <p aria-live="polite" className="sr-only">
            {phase.label}. {phase.summary}{" "}
            {phase.metrics
              .map(([label, value]) => `${label}: ${value}`)
              .join(". ")}
          </p>
        </section>
      </div>
    </section>
  );
}

export function ExecutionEnvelopeComparison() {
  return (
    <section className="py-8" aria-labelledby="comparison-title">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="font-mono text-base tracking-wide text-primary sm:text-sm">
            EXECUTION ENVELOPES
          </p>
          <h2
            id="comparison-title"
            className="mt-1 text-balance text-2xl font-semibold tracking-tight"
          >
            One tick against current documented limits
          </h2>
        </div>
        <p className="max-w-[52ch] text-pretty text-base text-muted-foreground sm:text-sm">
          The same stored state, atomic write, and scalar Conway computation are
          compared against each runtime's published limits.
        </p>
      </div>

      <div
        data-xray-horizontal-scroll="execution-envelopes"
        role="region"
        aria-label="Execution evidence comparison"
        tabIndex={0}
        className="-mx-4 -my-2 overflow-x-auto whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:-mx-6 lg:-mx-8"
      >
        <div className="inline-block min-w-full px-4 py-2 align-middle sm:px-6 lg:px-8">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">
              The Game of Life workload compared with Groundhog, Solana, and
              Ethereum evidence.
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th className="py-3 pr-6 font-medium whitespace-nowrap text-foreground">
                  Constraint
                </th>
                <th className="px-6 py-3 font-medium whitespace-nowrap text-foreground">
                  Groundhog local
                </th>
                <th className="px-6 py-3 font-medium whitespace-nowrap text-foreground">
                  Solana
                </th>
                <th className="py-3 pl-6 font-medium whitespace-nowrap text-foreground">
                  Ethereum
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border align-top">
              <ComparisonRow
                label="Persistent state"
                groundhog={
                  <ComparisonValue
                    value="25,000,000 bytes"
                    detail="Two persistent 12.5 MB banks hold the current and destination generations."
                    evidence="Stored on Groundhog"
                    positive
                  />
                }
                solana={
                  <ComparisonValue
                    value="10,485,760 bytes max / account"
                    detail={`One 12,500,000-byte bank is ${formatCount(SOLANA_BANK_OVERFLOW_BYTES)} bytes too large. Each bank requires at least ${SOLANA_MIN_ACCOUNTS_PER_BANK} accounts.`}
                    evidence="One bank cannot fit in one account"
                  />
                }
                ethereum={
                  <ComparisonValue
                    value={`${formatCount(ETHEREUM_PERSISTENT_SLOT_COUNT)} storage slots`}
                    detail="Two 12.5 MB banks stored in 32-byte EVM slots. Ethereum charges gas to access and write each slot."
                    evidence="State can persist; an atomic rewrite cannot fit"
                  />
                }
              />
              <ComparisonRow
                label="Atomic state write"
                groundhog={
                  <ComparisonValue
                    value="12,500,000 bytes / 20,000 chunks"
                    detail="The complete destination bank is written and committed with metadata in one transaction."
                    evidence="Fits in one Groundhog transaction"
                    positive
                  />
                }
                solana={
                  <ComparisonValue
                    value={`12,500,000 bytes across ≥${SOLANA_MIN_ACCOUNTS_PER_BANK} accounts`}
                    detail="The bank must be sharded across writable accounts. Sharding storage does not remove the transaction compute limit."
                    evidence="Storage requires a different account layout"
                  />
                }
                ethereum={
                  <ComparisonValue
                    value={`${formatCount(ETHEREUM_DIRECT_SLOT_ACCESS_LIST_GAS)} gas before writes`}
                    detail={`The ${formatCount(ETHEREUM_WRITE_SLOT_COUNT)} EIP-2930 storage-key entries alone cost ${ETHEREUM_ACCESS_GAS_BLOCK_MULTIPLE.toFixed(1)}× the current 60,000,000-gas block limit, before address, transaction, SSTORE, or compute gas. Cold access costs more.`}
                    evidence="Cannot fit in one Ethereum block"
                  />
                }
              />
              <ComparisonRow
                label="Scalar Conway compute"
                groundhog={
                  <ComparisonValue
                    value="100,000,000 cell outcomes"
                    detail={`Every cell was evaluated and the full tick completed in ${EXECUTION_EVIDENCE.groundhog.measuredSeconds.toFixed(2)} seconds locally.`}
                    evidence="Completed in one Groundhog transaction"
                    positive
                  />
                }
                solana={
                  <ComparisonValue
                    value={`${SOLANA_COMPUTE_UNITS_PER_CELL.toFixed(3)} CU available / cell`}
                    detail={`Assigning only one metered SBF instruction, one CU, to each scalar cell would require 100,000,000 CU, ${SOLANA_SCALAR_FLOOR_MULTIPLE.toFixed(1)}× the transaction cap, before the actual rule, reads, or writes.`}
                    evidence="Cannot fit in one Solana transaction"
                  />
                }
                ethereum={
                  <ComparisonValue
                    value={`${ETHEREUM_GAS_PER_CELL.toFixed(1)} gas available / cell`}
                    detail={`Assigning only one PUSH0-priced, 2-gas opcode to each scalar cell would cost ${formatCount(ETHEREUM_ONE_OPCODE_SCALAR_GAS)} gas, ${ETHEREUM_SCALAR_FLOOR_BLOCK_MULTIPLE.toFixed(1)}× the block limit, before Conway logic or storage.`}
                    evidence="Cannot fit in one Ethereum block"
                  />
                }
              />
              <ComparisonRow
                label="One atomic tick"
                groundhog={
                  <ComparisonValue
                    value="Completed"
                    detail={`100 million cells and a 12.5 MB state write on ${EXECUTION_EVIDENCE.groundhog.protocol}.`}
                    evidence="Possible on Groundhog"
                    positive
                  />
                }
                solana={
                  <ComparisonValue
                    value="Cannot fit in one transaction"
                    detail={`Each bank requires account sharding. The scalar compute floor exceeds the ${formatCount(EXECUTION_EVIDENCE.solana.maxTransactionComputeUnits)}-CU cap by ${SOLANA_SCALAR_FLOOR_MULTIPLE.toFixed(1)}×.`}
                    evidence="Blocked by the transaction compute cap"
                  />
                }
                ethereum={
                  <ComparisonValue
                    value="Cannot fit in one block"
                    detail={`Storage-key access alone is ${ETHEREUM_ACCESS_GAS_BLOCK_MULTIPLE.toFixed(1)}× the gas limit; scalar compute also exceeds it.`}
                    evidence="Blocked by storage gas + compute gas"
                  />
                }
              />
            </tbody>
          </table>
        </div>
      </div>

      <nav
        aria-label="Execution comparison sources"
        className="border-t border-border pt-5"
      >
        <p className="font-mono text-base font-medium text-foreground sm:text-sm">
          Primary sources
        </p>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3 text-base sm:text-sm">
          <SourceLink href={EXECUTION_EVIDENCE.groundhog.source}>
            Groundhog workload and local results
          </SourceLink>
          <SourceLink href={EXECUTION_EVIDENCE.solana.feesSource}>
            Solana compute budget
          </SourceLink>
          <SourceLink href={EXECUTION_EVIDENCE.solana.accountsSource}>
            Solana account limits
          </SourceLink>
          <SourceLink href={EXECUTION_EVIDENCE.solana.meteringSource}>
            Solana SBF instruction meter
          </SourceLink>
          <SourceLink href={EXECUTION_EVIDENCE.ethereum.blocksSource}>
            Ethereum block gas
          </SourceLink>
          <SourceLink href={EXECUTION_EVIDENCE.ethereum.storageSource}>
            Ethereum storage-access gas
          </SourceLink>
          <SourceLink href={EXECUTION_EVIDENCE.ethereum.opcodesSource}>
            Ethereum opcode gas
          </SourceLink>
        </div>
      </nav>
    </section>
  );
}

function ComparisonRow({
  label,
  groundhog,
  solana,
  ethereum,
}: {
  readonly label: string;
  readonly groundhog: React.ReactNode;
  readonly solana: React.ReactNode;
  readonly ethereum: React.ReactNode;
}) {
  return (
    <tr>
      <th
        scope="row"
        className="min-w-48 py-5 pr-6 font-medium whitespace-normal text-foreground"
      >
        {label}
      </th>
      <td className="min-w-72 px-6 py-5 whitespace-normal">{groundhog}</td>
      <td className="min-w-72 px-6 py-5 whitespace-normal">{solana}</td>
      <td className="min-w-72 py-5 pl-6 whitespace-normal">{ethereum}</td>
    </tr>
  );
}

function ComparisonValue({
  value,
  detail,
  evidence,
  positive = false,
}: {
  readonly value: string;
  readonly detail: string;
  readonly evidence: string;
  readonly positive?: boolean;
}) {
  return (
    <div className="grid gap-1">
      <p
        className={cn(
          "font-mono text-lg tabular-nums sm:text-base",
          positive ? "text-primary" : "text-foreground",
        )}
      >
        {value}
      </p>
      <p className="max-w-[38ch] text-pretty text-base text-muted-foreground sm:text-sm">
        {detail}
      </p>
      <p className="font-mono text-base text-warning sm:text-sm">{evidence}</p>
    </div>
  );
}

function SourceLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline decoration-border underline-offset-4 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </a>
  );
}
