import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Dna } from "lucide-react";
import type { ReadAppConfig } from "@/config";
import { cn } from "@/lib/utils";
import { snapshotEligibilityError } from "./evidence";
import {
  neighborhoodCoordinates,
  type ConwayOutcome,
  type ExactCellInspection,
} from "./exact-cell";
import { useXrayEvidence } from "./use-xray-evidence";
import {
  bankRolesForGeneration,
  formatCount,
  mapCellToStorage,
  parseCellQuery,
  parseCoordinateInput,
  withCellQuery,
  type BankRoles,
  type CellStorageAddress,
} from "./workload";

type InspectionState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: ExactCellInspection }
  | { readonly status: "error"; readonly message: string };

const OUTCOME_LABELS: Record<ConwayOutcome, string> = {
  birth: "Birth",
  survival: "Survival",
  loneliness: "Death by loneliness",
  overcrowding: "Death by overcrowding",
  "remains-dead": "Remains dead",
};

export function XrayPage({
  config,
}: {
  readonly config: Readonly<ReadAppConfig>;
}) {
  const initialCoordinate = parseCellQuery(window.location.search);
  const [address, setAddress] = useState(() =>
    mapCellToStorage(initialCoordinate.x, initialCoordinate.y),
  );
  const [xInput, setXInput] = useState(String(initialCoordinate.x));
  const [yInput, setYInput] = useState(String(initialCoordinate.y));
  const [invalid, setInvalid] = useState({ x: false, y: false });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [inspectionState, setInspectionState] = useState<InspectionState>({
    status: "idle",
  });
  const inspectionRequest = useRef<AbortController | null>(null);
  const evidence = useXrayEvidence(config);
  const chain = evidence.state.chain.value;
  const snapshot = evidence.state.snapshot.value;
  const snapshotUsable =
    snapshot !== null &&
    (chain === null ||
      snapshotEligibilityError(snapshot, chain, config) === null);
  const inspection =
    inspectionState.status === "ready" ? inspectionState.value : null;
  const roleGeneration =
    inspection?.generation ??
    (snapshotUsable ? snapshot.manifest.generation : null);
  const bankRoles = roleGeneration
    ? bankRolesForGeneration(BigInt(roleGeneration))
    : null;
  const resultOutdated = Boolean(
    inspection &&
    snapshot &&
    inspection.digest !== snapshot.manifest.stateDigest,
  );

  useEffect(
    () => () => {
      inspectionRequest.current?.abort(
        new DOMException("X-Ray inspection disposed", "AbortError"),
      );
    },
    [],
  );

  const inspect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const x = parseCoordinateInput(xInput);
    const y = parseCoordinateInput(yInput);
    setInvalid({ x: x === null, y: y === null });
    if (x === null || y === null) {
      setValidationError(
        "Enter whole-number x and y coordinates from 0 through 9,999.",
      );
      return;
    }
    if (!snapshotUsable) return;
    const nextAddress = mapCellToStorage(x, y);
    const nextUrl = withCellQuery(new URL(window.location.href), { x, y });
    window.history.replaceState(
      window.history.state,
      "",
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    );
    setAddress(nextAddress);
    setXInput(String(x));
    setYInput(String(y));
    setInvalid({ x: false, y: false });
    setValidationError(null);
    inspectionRequest.current?.abort(
      new DOMException("Superseded by a newer inspection", "AbortError"),
    );
    const controller = new AbortController();
    inspectionRequest.current = controller;
    setInspectionState({ status: "loading" });
    void evidence
      .inspectCell(snapshot, x, y, controller.signal)
      .then((value) => {
        if (inspectionRequest.current !== controller) return;
        setInspectionState({ status: "ready", value });
      })
      .catch((cause: unknown) => {
        if (
          controller.signal.aborted ||
          inspectionRequest.current !== controller
        )
          return;
        setInspectionState({
          status: "error",
          message:
            cause instanceof Error
              ? cause.message
              : "Exact-cell inspection failed",
        });
      });
  };

  const changeCoordinate = (axis: "x" | "y", value: string) => {
    const nextXInput = axis === "x" ? value : xInput;
    const nextYInput = axis === "y" ? value : yInput;
    if (axis === "x") setXInput(value);
    else setYInput(value);
    const x = parseCoordinateInput(nextXInput);
    const y = parseCoordinateInput(nextYInput);
    if (x === null || y === null) return;
    const nextAddress = mapCellToStorage(x, y);
    if (nextAddress.x === address.x && nextAddress.y === address.y) return;
    inspectionRequest.current?.abort(
      new DOMException("Coordinate changed", "AbortError"),
    );
    inspectionRequest.current = null;
    setAddress(nextAddress);
    setInspectionState({ status: "idle" });
    setInvalid({ x: false, y: false });
    setValidationError(null);
    const nextUrl = withCellQuery(new URL(window.location.href), { x, y });
    window.history.replaceState(
      window.history.state,
      "",
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    );
  };

  return (
    <div className="min-h-dvh bg-background text-foreground antialiased">
      <a
        href="#xray-content"
        className="sr-only z-50 rounded-md bg-foreground px-3 py-2 text-sm text-background outline-none focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to X-Ray content
      </a>
      <XrayHeader
        config={config}
        sourceHealth={evidence.relationship.label}
        onRefresh={evidence.retry}
      />
      <main id="xray-content" className="isolate overflow-x-clip">
        <div className="mx-auto max-w-[90rem] px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
          <CellDebugger
            address={address}
            bankRoles={bankRoles}
            generation={roleGeneration}
            inspectionState={inspectionState}
            invalid={invalid}
            resultOutdated={resultOutdated}
            snapshotUsable={snapshotUsable}
            validationError={validationError}
            xInput={xInput}
            yInput={yInput}
            onInspect={inspect}
            onXChange={(value) => changeCoordinate("x", value)}
            onYChange={(value) => changeCoordinate("y", value)}
          />
        </div>
      </main>
      <p aria-live="polite" className="sr-only">
        {evidence.announcement}
      </p>
    </div>
  );
}

function XrayHeader({
  config,
  sourceHealth,
  onRefresh,
}: {
  readonly config: Readonly<ReadAppConfig>;
  readonly sourceHealth: string;
  readonly onRefresh: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 pt-[max(.5rem,var(--safe-top))] pr-[max(.75rem,var(--safe-right))] pb-2 pl-[max(.75rem,var(--safe-left))] backdrop-blur-xl sm:pr-[max(1.5rem,var(--safe-right))] sm:pl-[max(1.5rem,var(--safe-left))]">
      <div className="mx-auto flex max-w-[90rem] items-center justify-between gap-4">
        <a
          href="/"
          aria-label="Homepage"
          className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Dna aria-hidden="true" className="size-6 shrink-0 stroke-primary" />
          <span className="min-w-0">
            <span className="block truncate font-medium">Life Observatory</span>
            <span className="hidden truncate font-mono text-sm text-muted-foreground sm:block">
              {config.networkId.slice(0, 8)}… / cell debugger
            </span>
          </span>
        </a>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={`Refresh evidence. Current status: ${sourceHealth}`}
            title={`Evidence: ${sourceHealth}. Activate to refresh.`}
            onClick={onRefresh}
            className="inline-flex size-9 items-center justify-center rounded-md font-mono text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring lg:size-auto lg:max-w-56 lg:justify-start lg:gap-2 lg:px-2"
          >
            <span
              aria-hidden="true"
              className={cn(
                sourceHealth === "Chain and snapshot aligned"
                  ? "text-primary"
                  : "text-warning",
              )}
            >
              ●
            </span>
            <span className="hidden truncate lg:inline">{sourceHealth}</span>
          </button>
          <nav
            aria-label="Primary navigation"
            className="flex items-center gap-1"
          >
            <a
              href="/"
              className="inline-flex h-12 items-center rounded-md px-3 text-base text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
            >
              World
            </a>
            <a
              href="/xray"
              aria-current="page"
              className="inline-flex h-12 items-center rounded-md bg-muted px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
            >
              X-Ray
            </a>
          </nav>
        </div>
      </div>
    </header>
  );
}

function CellDebugger({
  address,
  bankRoles,
  generation,
  inspectionState,
  invalid,
  resultOutdated,
  snapshotUsable,
  validationError,
  xInput,
  yInput,
  onInspect,
  onXChange,
  onYChange,
}: {
  readonly address: CellStorageAddress;
  readonly bankRoles: BankRoles | null;
  readonly generation: string | null;
  readonly inspectionState: InspectionState;
  readonly invalid: Readonly<{ x: boolean; y: boolean }>;
  readonly resultOutdated: boolean;
  readonly snapshotUsable: boolean;
  readonly validationError: string | null;
  readonly xInput: string;
  readonly yInput: string;
  readonly onInspect: (event: FormEvent<HTMLFormElement>) => void;
  readonly onXChange: (value: string) => void;
  readonly onYChange: (value: string) => void;
}) {
  const errorId = useId();
  const inspection =
    inspectionState.status === "ready" ? inspectionState.value : null;
  return (
    <section aria-labelledby="xray-title">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="font-mono text-base tracking-wide text-primary sm:text-sm">
            EXACT CELL DEBUGGER
          </p>
          <h1
            id="xray-title"
            className="mt-1 text-balance text-3xl font-semibold tracking-tight"
          >
            Transaction X-Ray
          </h1>
        </div>
        <p className="font-mono text-base text-muted-foreground tabular-nums sm:text-sm">
          Generation {generation ?? "—"} / cell {formatCount(address.x)},
          {formatCount(address.y)}
        </p>
      </div>

      <form
        onSubmit={onInspect}
        className="grid gap-4 border-b border-border py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
        noValidate
      >
        <CoordinateInput
          axis="x"
          describedBy={validationError ? errorId : undefined}
          invalid={invalid.x}
          value={xInput}
          onChange={onXChange}
        />
        <CoordinateInput
          axis="y"
          describedBy={validationError ? errorId : undefined}
          invalid={invalid.y}
          value={yInput}
          onChange={onYChange}
        />
        <button
          type="submit"
          disabled={!snapshotUsable}
          className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-3 text-base font-medium text-primary-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45 sm:h-9 sm:text-sm"
        >
          {inspectionState.status === "loading"
            ? "Inspect another cell"
            : "Inspect exact cell"}
        </button>
        {validationError ? (
          <p
            id={errorId}
            role="alert"
            className="text-base text-destructive sm:col-span-3 sm:text-sm"
          >
            {validationError}
          </p>
        ) : null}
        {!snapshotUsable ? (
          <p className="text-base text-muted-foreground sm:col-span-3 sm:text-sm">
            Waiting for a validated immutable snapshot. Address calculations
            remain available.
          </p>
        ) : null}
      </form>

      <div
        role="status"
        aria-live="polite"
        className="border-b border-border py-3 font-mono text-base text-muted-foreground sm:text-sm"
      >
        {inspectionStatus(inspectionState, resultOutdated)}
      </div>

      <div className="grid border-b border-border lg:grid-cols-[2fr_3fr] lg:divide-x lg:divide-border">
        <NeighborhoodAndRule address={address} inspection={inspection} />
        <StorageTrace
          address={address}
          bankRoles={bankRoles}
          generation={generation}
          inspection={inspection}
        />
      </div>
    </section>
  );
}

function CoordinateInput({
  axis,
  describedBy,
  invalid,
  value,
  onChange,
}: {
  readonly axis: "x" | "y";
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1.5">
      <span className="font-mono text-base font-medium text-foreground sm:text-sm">
        Coordinate {axis}
      </span>
      <input
        id={id}
        name={`cell-${axis}`}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={value}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className="h-12 min-w-0 rounded-md border border-border bg-background px-3 font-mono text-base text-foreground tabular-nums outline-none focus-visible:-outline-offset-1 focus-visible:outline-2 focus-visible:outline-ring sm:h-10"
      />
    </label>
  );
}

function NeighborhoodAndRule({
  address,
  inspection,
}: {
  readonly address: CellStorageAddress;
  readonly inspection: ExactCellInspection | null;
}) {
  const coordinates =
    inspection?.cells ?? neighborhoodCoordinates(address.x, address.y);
  return (
    <section
      className="min-w-0 py-7 lg:pr-8"
      aria-labelledby="neighborhood-title"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="font-mono text-base text-primary sm:text-sm">
            CELL AND NEIGHBORS
          </p>
          <h2
            id="neighborhood-title"
            className="mt-1 text-balance text-2xl font-semibold tracking-tight"
          >
            3 × 3 neighborhood
          </h2>
        </div>
        <p className="font-mono text-base text-muted-foreground sm:text-sm">
          {inspection ? `Generation ${inspection.generation}` : "Not loaded"}
        </p>
      </div>

      <ol
        role="list"
        aria-label="Selected cell neighborhood"
        className="mt-5 grid grid-cols-3 gap-1.5"
      >
        {coordinates.map((cell, index) => {
          const selected = index === 4;
          const alive = "alive" in cell ? cell.alive : null;
          return (
            <li
              key={`${cell.dx}:${cell.dy}`}
              aria-current={selected ? "true" : undefined}
              aria-label={`Cell ${cell.x}, ${cell.y}: ${alive === null ? "not loaded" : alive ? "alive" : "dead"}${selected ? ", selected" : ""}`}
              className={cn(
                "flex min-h-24 min-w-0 flex-col items-center justify-center gap-1 rounded-md border p-2 font-mono tabular-nums sm:min-h-20",
                selected
                  ? "border-warning ring-1 ring-warning/35"
                  : "border-border",
                alive === true
                  ? "bg-primary text-primary-foreground"
                  : alive === false
                    ? "bg-background text-muted-foreground"
                    : "bg-muted/30 text-muted-foreground",
              )}
            >
              <p className="text-2xl font-medium">
                {alive === null ? "?" : alive ? "1" : "0"}
              </p>
              <p className="truncate text-base sm:text-sm">
                {cell.x},{cell.y}
              </p>
            </li>
          );
        })}
      </ol>

      <dl className="mt-5 grid grid-cols-3 divide-x divide-border border-y border-border font-mono tabular-nums">
        <RuleValue
          label="Current"
          value={
            inspection
              ? inspection.currentAlive
                ? "1 / alive"
                : "0 / dead"
              : "—"
          }
        />
        <RuleValue
          label="Neighbors"
          value={inspection ? String(inspection.liveNeighbors) : "—"}
        />
        <RuleValue
          label="Next"
          value={
            inspection ? (inspection.nextAlive ? "1 / alive" : "0 / dead") : "—"
          }
          derived
        />
      </dl>

      <p className="mt-4 text-pretty text-base text-foreground sm:text-sm">
        {inspection
          ? `${inspection.liveNeighbors} live neighbors → ${OUTCOME_LABELS[inspection.outcome]}`
          : "Inspect the cell to evaluate its Conway result."}
      </p>
      <p className="mt-1 text-pretty text-base text-muted-foreground sm:text-sm">
        The next value is browser-derived from immutable snapshot cells and is
        not canonical state.
      </p>
    </section>
  );
}

function RuleValue({
  label,
  value,
  derived = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly derived?: boolean;
}) {
  return (
    <div className="min-w-0 px-3 py-3 first:pl-0 last:pr-0">
      <dt className="font-medium text-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-1 break-words",
          derived ? "text-warning" : "text-muted-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function StorageTrace({
  address,
  bankRoles,
  generation,
  inspection,
}: {
  readonly address: CellStorageAddress;
  readonly bankRoles: BankRoles | null;
  readonly generation: string | null;
  readonly inspection: ExactCellInspection | null;
}) {
  const partStart = address.part === 0 ? 0 : 8_000;
  const partEnd = address.part === 0 ? 7_999 : 9_999;
  const nextGeneration = generation
    ? (BigInt(generation) + 1n).toString()
    : null;
  return (
    <section
      className="min-w-0 border-t border-border py-7 lg:border-t-0 lg:pl-8"
      aria-labelledby="storage-title"
    >
      <p className="font-mono text-base text-warning sm:text-sm">
        PACKED CONTRACT STORAGE
      </p>
      <h2
        id="storage-title"
        className="mt-1 text-balance text-2xl font-semibold tracking-tight"
      >
        One cell, one bit, the same address next generation
      </h2>

      <PackedByte address={address} inspection={inspection} />

      <ol className="mt-6 divide-y divide-border border-y border-border tabular-nums">
        <Calculation
          step={1}
          label="Find the byte"
          explanation={`One byte holds 8 cells. Cell x ${formatCount(address.x)} is stored in byte ${formatCount(address.byteInRow)}.`}
          formula={`floor(${formatCount(address.x)} ÷ 8)`}
          value={formatCount(address.byteInRow)}
        />
        <Calculation
          step={2}
          label="Find the bit"
          explanation={`This is position ${address.bit + 1} of 8 in that byte, stored as bit ${address.bit}.`}
          formula={`${formatCount(address.x)} mod 8`}
          value={String(address.bit)}
        />
        <Calculation
          step={3}
          label="Choose the row chunk"
          explanation={`Each row has a left chunk (part 0) and a right chunk (part 1). This cell is in the ${address.part === 0 ? "left" : "right"} chunk.`}
          formula={`x ${formatCount(partStart)}–${formatCount(partEnd)}`}
          value={String(address.part)}
        />
        <Calculation
          step={4}
          label="Find the byte inside the chunk"
          explanation={`${address.part === 0 ? "The left chunk starts at row byte 0" : "The right chunk starts at row byte 1,000"}, so row byte ${formatCount(address.byteInRow)} becomes byte ${formatCount(address.byteInPart)} inside the chunk.`}
          formula={
            address.part === 0
              ? `${formatCount(address.byteInRow)} − 0`
              : `${formatCount(address.byteInRow)} − 1,000`
          }
          value={formatCount(address.byteInPart)}
        />
        <Calculation
          step={5}
          label="Build the storage key"
          explanation={`Every row has two chunk keys. Row ${formatCount(address.y)}'s ${address.part === 0 ? "left" : "right"} chunk uses key ${formatCount(address.chunkKey)}.`}
          formula={`${formatCount(address.y)} × 2 + ${address.part}`}
          value={formatCount(address.chunkKey)}
          emphasized
        />
      </ol>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-3 font-mono tabular-nums">
        <BankLocation
          label="Current"
          bank={bankRoles?.active ?? null}
          generation={generation}
          value={inspection?.currentAlive}
        />
        <div
          className="flex items-center text-2xl text-warning"
          aria-hidden="true"
        >
          →
        </div>
        <BankLocation
          label="Next"
          bank={bankRoles?.inactive ?? null}
          generation={nextGeneration}
          value={inspection?.nextAlive}
          derived
        />
      </div>
      <p className="mt-3 font-mono text-base text-muted-foreground tabular-nums sm:text-sm">
        Same location: row {formatCount(address.y)} / key{" "}
        {formatCount(address.chunkKey)} / byte {formatCount(address.byteInPart)}{" "}
        / bit {address.bit}
      </p>
    </section>
  );
}

function PackedByte({
  address,
  inspection,
}: {
  readonly address: CellStorageAddress;
  readonly inspection: ExactCellInspection | null;
}) {
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-base font-medium text-foreground sm:text-sm">
          Packed byte {formatCount(address.byteInRow)}
        </p>
        <p className="font-mono text-base text-muted-foreground sm:text-sm">
          LSB-first
        </p>
      </div>
      <ol
        role="list"
        aria-label={`Byte ${address.byteInRow} bit values`}
        data-xray-horizontal-scroll="byte-values"
        className="mt-2 flex gap-1 overflow-x-auto pb-2"
      >
        {Array.from({ length: 8 }, (_, bit) => {
          const value = inspection?.byteCells[bit]?.alive;
          const selected = bit === address.bit;
          return (
            <li
              key={bit}
              aria-current={selected ? "true" : undefined}
              aria-label={`Bit ${bit}: ${value === undefined ? "not loaded" : value ? "1, alive" : "0, dead"}${selected ? ", selected cell" : ""}`}
              className={cn(
                "flex min-h-16 min-w-14 flex-1 flex-col items-center justify-center rounded-md border font-mono tabular-nums",
                selected
                  ? "border-warning bg-warning/10 text-warning"
                  : "border-border text-muted-foreground",
              )}
            >
              <p className="text-base sm:text-sm">bit {bit}</p>
              <p className="text-lg font-medium">
                {value === undefined ? "?" : value ? "1" : "0"}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Calculation({
  step,
  label,
  explanation,
  formula,
  value,
  emphasized = false,
}: {
  readonly step: number;
  readonly label: string;
  readonly explanation: string;
  readonly formula: string;
  readonly value: string;
  readonly emphasized?: boolean;
}) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 py-4">
      <span className="flex size-8 items-center justify-center rounded-full border border-border font-mono text-sm text-muted-foreground">
        {step}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
          <h3 className="font-medium text-foreground">{label}</h3>
          <p className="font-mono text-muted-foreground">
            <span>{formula}</span>{" "}
            <span className={emphasized ? "text-warning" : "text-foreground"}>
              = {value}
            </span>
          </p>
        </div>
        <p className="mt-1 max-w-[62ch] text-muted-foreground">{explanation}</p>
      </div>
    </li>
  );
}

function BankLocation({
  label,
  bank,
  generation,
  value,
  derived = false,
}: {
  readonly label: string;
  readonly bank: "A" | "B" | null;
  readonly generation: string | null;
  readonly value: boolean | undefined;
  readonly derived?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md border p-3",
        derived
          ? "border-warning/50 bg-warning/8"
          : "border-primary/50 bg-primary/8",
      )}
    >
      <p
        className={cn(
          "text-base sm:text-sm",
          derived ? "text-warning" : "text-primary",
        )}
      >
        {label} / Bank {bank ?? "?"}
      </p>
      <p className="mt-1 text-base text-muted-foreground sm:text-sm">
        Generation {generation ?? "—"}
      </p>
      <p className="mt-3 text-2xl font-medium">
        {value === undefined ? "?" : value ? "1 / alive" : "0 / dead"}
      </p>
      {derived ? (
        <p className="mt-1 text-base text-muted-foreground sm:text-sm">
          Browser-derived
        </p>
      ) : null}
    </div>
  );
}

function inspectionStatus(state: InspectionState, outdated: boolean): string {
  switch (state.status) {
    case "idle":
      return "No exact cell data loaded.";
    case "loading":
      return "Loading the exact immutable neighborhood.";
    case "error":
      return `Inspection failed: ${state.message}`;
    case "ready":
      return outdated
        ? `Showing retained generation ${state.value.generation}; a newer snapshot is available.`
        : `Loaded cell ${state.value.x}, ${state.value.y} from generation ${state.value.generation}.`;
  }
}
