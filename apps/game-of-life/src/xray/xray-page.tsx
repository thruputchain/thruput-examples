import { useId, useState, type FormEvent } from "react";
import { Dna } from "lucide-react";
import type { ReadAppConfig } from "@/config";
import { cn } from "@/lib/utils";
import {
  formatCount,
  LIFE_WORKLOAD,
  mapCellToStorage,
  parseCellQuery,
  parseCoordinateInput,
  withCellQuery,
  type CellStorageAddress,
} from "./workload";

const WORLD_WIDTH = formatCount(LIFE_WORKLOAD.worldWidth);
const WORLD_HEIGHT = formatCount(LIFE_WORKLOAD.worldHeight);
const CELL_COUNT = formatCount(LIFE_WORKLOAD.cellCount);
const ROW_BYTES = formatCount(LIFE_WORKLOAD.rowBytes);
const BANK_BYTES = formatCount(LIFE_WORKLOAD.bankBytes);
const CHUNKS_PER_BANK = formatCount(LIFE_WORKLOAD.chunksPerBank);
const STEADY_STATE_BYTES = formatCount(LIFE_WORKLOAD.steadyStateBankBytes);
const RULE_EVALUATIONS = formatCount(LIFE_WORKLOAD.ruleEvaluations);

const SCALES = [
  {
    id: "cell",
    label: "Cell",
    value: "1",
    unit: "binary state",
    detail: "One Conway cell is either alive or dead in the canonical world.",
  },
  {
    id: "bit",
    label: "Bit",
    value: "1",
    unit: "LSB-first bit",
    detail:
      "The contract packs each cell into one least-significant-bit-first position.",
  },
  {
    id: "byte",
    label: "Byte",
    value: formatCount(LIFE_WORKLOAD.bitsPerByte),
    unit: "horizontal cells",
    detail: `One canonical byte carries ${formatCount(LIFE_WORKLOAD.bitsPerByte)} adjacent cells from the same row.`,
  },
  {
    id: "chunk",
    label: "Chunk",
    value: `${formatCount(LIFE_WORKLOAD.chunkBytes)} + ${formatCount(LIFE_WORKLOAD.tailBytes)}`,
    unit: "bytes per row split",
    detail:
      "The bytestring limit divides every row into a head and an exact-size tail.",
  },
  {
    id: "row",
    label: "Row",
    value: ROW_BYTES,
    unit: "bytes",
    detail: `${WORLD_WIDTH} cells fit exactly into one row with no padding bits.`,
  },
  {
    id: "bank",
    label: "Bank",
    value: BANK_BYTES,
    unit: "bytes per generation",
    detail: `${CHUNKS_PER_BANK} chunks hold one complete canonical generation.`,
  },
  {
    id: "transaction",
    label: "Transaction",
    value: RULE_EVALUATIONS,
    unit: "logical rule evaluations",
    detail:
      "One invocation streams the read bank and writes the complete next bank.",
  },
  {
    id: "block",
    label: "Block",
    value: "all or nothing",
    unit: "atomic inclusion",
    detail:
      "The complete bank switch and metadata update commit together or revert together.",
  },
] as const;

type ScaleId = (typeof SCALES)[number]["id"];

export function XrayPage({
  config,
}: {
  readonly config: Readonly<ReadAppConfig>;
}) {
  const [selectedScale, setSelectedScale] = useState<ScaleId>("cell");
  const [address, setAddress] = useState(() => {
    const coordinate = parseCellQuery(window.location.search);
    return mapCellToStorage(coordinate.x, coordinate.y);
  });
  const scale = SCALES.find(({ id }) => id === selectedScale) ?? SCALES[0];
  const selectAddress = (x: number, y: number) => {
    const nextAddress = mapCellToStorage(x, y);
    const nextUrl = withCellQuery(new URL(window.location.href), { x, y });
    window.history.replaceState(
      window.history.state,
      "",
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    );
    setAddress(nextAddress);
  };
  return (
    <div className="min-h-dvh bg-background text-foreground antialiased">
      <a
        href="#xray-content"
        className="fixed top-2 left-2 z-50 -translate-y-20 rounded-md bg-foreground px-3 py-2 text-sm text-background outline-none focus:translate-y-0"
      >
        Skip to X-Ray content
      </a>
      <XrayHeader config={config} />
      <main id="xray-content" className="isolate overflow-x-clip">
        <Hero />
        <ScaleSection
          scale={scale}
          selectedScale={selectedScale}
          onSelect={setSelectedScale}
        />
        <StorageAtlas address={address} selectedScale={selectedScale} />
        <CellMicroscope
          address={address}
          selectedScale={selectedScale}
          onSelect={selectAddress}
        />
      </main>
    </div>
  );
}

function XrayHeader({ config }: { readonly config: Readonly<ReadAppConfig> }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 pt-[max(.5rem,var(--safe-top))] pr-[max(.75rem,var(--safe-right))] pb-2 pl-[max(.75rem,var(--safe-left))] backdrop-blur-xl sm:pr-[max(1.5rem,var(--safe-right))] sm:pl-[max(1.5rem,var(--safe-left))]">
      <div className="mx-auto flex max-w-[90rem] items-center justify-between gap-4">
        <a
          href="/"
          aria-label="Homepage"
          className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid size-12 shrink-0 place-items-center rounded-md border border-primary/35 bg-primary/10 text-primary sm:size-9 [@media(pointer:coarse)]:size-12">
            <Dna aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium">Life Observatory</span>
            <span className="hidden truncate font-mono text-sm text-muted-foreground sm:block">
              {config.networkId.slice(0, 8)}… / transaction x-ray
            </span>
          </span>
        </a>
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
    </header>
  );
}

function Hero() {
  return (
    <section className="relative border-b border-border py-16 sm:py-20 lg:py-28">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_28%,color-mix(in_oklab,var(--primary)_12%,transparent),transparent_28%),linear-gradient(to_bottom,transparent_70%,color-mix(in_oklab,var(--canvas)_70%,transparent))]"
      />
      <div className="relative mx-auto grid max-w-[90rem] gap-12 px-4 sm:px-6 lg:grid-cols-[3fr_2fr] lg:items-end lg:gap-16 lg:px-8">
        <div className="flex flex-col gap-6">
          <p className="font-mono text-base tracking-wide text-primary sm:text-sm">
            TRANSACTION X-RAY / STORAGE TO COMMIT
          </p>
          <h1 className="max-w-[20ch] text-balance text-5xl font-semibold tracking-tight sm:text-6xl lg:text-7xl">
            {CELL_COUNT} cells. One atomic transition.
          </h1>
          <p className="max-w-[58ch] text-pretty text-lg text-muted-foreground sm:text-base">
            Follow one Conway cell from its canonical bit through two persistent
            storage banks and into the transaction that commits the complete
            next generation.
          </p>
        </div>
        <div className="flex flex-col gap-3 border-l border-primary/35 pl-5 sm:pl-7">
          <p className="font-mono text-base tracking-wide text-primary sm:text-sm">
            DEMONSTRATION CLAIM
          </p>
          <p className="max-w-[42ch] text-pretty text-xl font-medium sm:text-lg">
            One Groundhog contract invocation reads, computes, and commits the
            exact next state of a persistent 100-million-cell Conway world
            atomically.
          </p>
          <p className="max-w-[52ch] text-pretty text-base text-muted-foreground sm:text-sm">
            Contract-derived workload. The browser explains the transition; it
            does not compute canonical state.
          </p>
        </div>
      </div>
      <dl className="relative mx-auto mt-14 grid max-w-[90rem] grid-cols-2 border-y border-border px-4 sm:px-6 lg:grid-cols-4 lg:px-8">
        <Metric
          label="World"
          value={`${WORLD_WIDTH} × ${WORLD_HEIGHT}`}
          detail="cells"
        />
        <Metric label="Encoding" value="1 bit" detail="per cell" />
        <Metric label="Generation" value={BANK_BYTES} detail="bytes" />
        <Metric
          label="Persistent banks"
          value={formatCount(LIFE_WORKLOAD.persistentBanks)}
          detail="A / B at steady state"
        />
      </dl>
    </section>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="flex flex-col gap-1 border-border py-5 odd:pr-4 even:border-l even:pl-4 lg:border-l lg:px-6 lg:first:border-l-0 lg:first:pl-0">
      <dt className="font-mono text-base text-muted-foreground sm:text-sm">
        {label}
      </dt>
      <dd className="font-mono text-xl font-medium tabular-nums sm:text-lg">
        {value}
      </dd>
      <dd className="text-base text-muted-foreground sm:text-sm">{detail}</dd>
    </div>
  );
}

function ScaleSection({
  scale,
  selectedScale,
  onSelect,
}: {
  readonly scale: (typeof SCALES)[number];
  readonly selectedScale: ScaleId;
  readonly onSelect: (value: ScaleId) => void;
}) {
  const scaleNumber = SCALES.findIndex(({ id }) => id === selectedScale) + 1;
  return (
    <section className="py-16 sm:py-20 lg:py-24" aria-labelledby="scale-title">
      <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3">
          <p className="font-mono text-base tracking-wide text-warning sm:text-sm">
            SCALE {String(scaleNumber).padStart(2, "0")} /{" "}
            {String(SCALES.length).padStart(2, "0")}
          </p>
          <h2
            id="scale-title"
            className="max-w-[35ch] text-balance text-4xl font-semibold tracking-tight"
          >
            From one cell to one committed block
          </h2>
          <p className="max-w-[58ch] text-pretty text-lg text-muted-foreground sm:text-base">
            Select a level to inspect how the same fixed workload changes shape
            without changing meaning.
          </p>
        </div>
        <div className="mt-10 grid gap-8 lg:grid-cols-[2fr_3fr] lg:gap-12">
          <ol
            role="list"
            className="flex snap-x gap-2 overflow-x-auto pb-2 lg:grid lg:grid-cols-2 lg:overflow-visible lg:pb-0"
          >
            {SCALES.map((item, index) => (
              <li key={item.id} className="min-w-32 snap-start lg:min-w-0">
                <button
                  type="button"
                  aria-pressed={selectedScale === item.id}
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    "flex min-h-12 w-full items-center gap-3 rounded-md border px-3 py-2 text-left font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-10 sm:text-sm",
                    selectedScale === item.id
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border bg-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="text-warning tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ol>
          <div
            className="relative flex min-h-72 flex-col gap-3 overflow-hidden rounded-lg border border-border bg-panel p-6 sm:p-8"
            aria-live="polite"
          >
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-primary to-transparent"
            />
            <p className="font-mono text-base text-primary sm:text-sm">
              {scale.label.toUpperCase()} / CONTRACT-DERIVED
            </p>
            <p className="max-w-full font-mono text-5xl font-medium tracking-tight text-balance tabular-nums [overflow-wrap:anywhere] sm:text-6xl">
              {scale.value}
            </p>
            <p className="font-mono text-base text-warning sm:text-sm">
              {scale.unit}
            </p>
            <p className="max-w-[48ch] text-pretty text-lg text-muted-foreground sm:text-base">
              {scale.detail}
            </p>
            <div
              className="absolute right-6 bottom-6 left-6 flex items-center gap-2"
              aria-hidden="true"
            >
              {SCALES.map((item) => (
                <span
                  key={item.id}
                  className={cn(
                    "h-1 flex-1",
                    item.id === selectedScale ? "bg-primary" : "bg-border",
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CellMicroscope({
  address,
  selectedScale,
  onSelect,
}: {
  readonly address: CellStorageAddress;
  readonly selectedScale: ScaleId;
  readonly onSelect: (x: number, y: number) => void;
}) {
  const errorId = useId();
  const [xInput, setXInput] = useState(String(address.x));
  const [yInput, setYInput] = useState(String(address.y));
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState({ x: false, y: false });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const x = parseCoordinateInput(xInput);
    const y = parseCoordinateInput(yInput);
    setInvalid({ x: x === null, y: y === null });
    if (x === null || y === null) {
      const axes = [x === null ? "x" : null, y === null ? "y" : null].filter(
        (axis): axis is string => axis !== null,
      );
      setError(
        `Enter a whole-number ${axes.join(" and ")} coordinate from 0 through 9,999.`,
      );
      return;
    }
    setInvalid({ x: false, y: false });
    setError(null);
    setXInput(String(x));
    setYInput(String(y));
    onSelect(x, y);
  };
  const firstCellInByte = address.byteInRow * LIFE_WORKLOAD.bitsPerByte;
  return (
    <section
      className="border-t border-border py-16 sm:py-20 lg:py-24"
      aria-labelledby="microscope-title"
      data-scale-focus={selectedScale}
    >
      <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3">
          <p className="font-mono text-base tracking-wide text-warning sm:text-sm">
            CELL MICROSCOPE / EXACT ADDRESS
          </p>
          <h2
            id="microscope-title"
            className="max-w-[35ch] text-balance text-4xl font-semibold tracking-tight"
          >
            Pinpoint any cell in canonical storage
          </h2>
          <p className="max-w-[58ch] text-pretty text-lg text-muted-foreground sm:text-base">
            Coordinates map deterministically to one byte, one LSB-first bit,
            and one chunk key. This view exposes address positions, not live or
            dead cell values.
          </p>
        </div>

        <form
          onSubmit={submit}
          className="mt-10 flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-panel p-4 sm:flex-row sm:flex-wrap sm:items-end sm:p-5"
          noValidate
        >
          <CoordinateInput
            axis="x"
            describedBy={error ? errorId : undefined}
            invalid={invalid.x}
            value={xInput}
            onChange={setXInput}
          />
          <CoordinateInput
            axis="y"
            describedBy={error ? errorId : undefined}
            invalid={invalid.y}
            value={yInput}
            onChange={setYInput}
          />
          <button
            type="submit"
            className="inline-flex h-12 shrink-0 items-center justify-center rounded-md bg-primary px-3 text-base font-medium text-primary-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-9 sm:text-sm"
          >
            Locate cell
          </button>
          {error ? (
            <p
              id={errorId}
              role="alert"
              className="text-base text-destructive sm:basis-full sm:text-sm"
            >
              {error}
            </p>
          ) : null}
        </form>

        <div className="mt-10 grid gap-8 lg:grid-cols-[3fr_2fr] lg:gap-12">
          <div
            className={cn(
              "min-w-0 rounded-lg border p-5",
              ["cell", "bit", "byte"].includes(selectedScale)
                ? "border-warning/50 bg-warning/5"
                : "border-border",
            )}
          >
            <div className="flex items-baseline justify-between gap-4 border-b border-border pb-4">
              <h3 className="text-balance text-2xl font-semibold tracking-tight">
                Byte {formatCount(address.byteInRow)}
              </h3>
              <p className="font-mono text-base text-muted-foreground sm:text-sm">
                LSB first / x {formatCount(firstCellInByte)}–
                {formatCount(firstCellInByte + LIFE_WORKLOAD.bitsPerByte - 1)}
              </p>
            </div>
            <ol
              role="list"
              aria-label={`Byte ${address.byteInRow} bit positions`}
              className="mt-5 flex gap-2 overflow-x-auto pb-2"
            >
              {Array.from({ length: LIFE_WORKLOAD.bitsPerByte }, (_, bit) => {
                const selected = bit === address.bit;
                return (
                  <li
                    key={bit}
                    aria-current={selected ? "true" : undefined}
                    aria-label={`Bit ${bit}, cell x ${firstCellInByte + bit}${selected ? ", selected" : ""}`}
                    className={cn(
                      "flex size-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border font-mono tabular-nums sm:size-auto sm:aspect-square sm:flex-1",
                      selected
                        ? "border-warning bg-warning/10 text-warning"
                        : "border-border bg-panel text-muted-foreground",
                    )}
                  >
                    <span className="text-lg">b{bit}</span>
                    <span className="text-base sm:text-sm">
                      x{formatCount(firstCellInByte + bit)}
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-4 max-w-[58ch] text-pretty text-base text-muted-foreground sm:text-sm">
              The highlighted position identifies the selected cell. Bit values
              remain deliberately unknown until a verified generation supplies
              exact cell data.
            </p>
          </div>

          <div
            className={cn(
              "rounded-lg border bg-canvas p-5",
              ["chunk", "row", "bank"].includes(selectedScale)
                ? "border-warning/50"
                : "border-border",
            )}
          >
            <p className="font-mono text-base text-primary sm:text-sm">
              ROW {formatCount(address.y)} / PART {address.part}
            </p>
            <dl className="mt-5 grid grid-cols-2 border-y border-border">
              <AddressMetric
                focused={selectedScale === "cell"}
                label="x"
                value={address.x}
              />
              <AddressMetric
                focused={selectedScale === "row"}
                label="y"
                value={address.y}
              />
              <AddressMetric
                focused={selectedScale === "byte"}
                label="byte_in_row"
                value={address.byteInRow}
              />
              <AddressMetric
                focused={selectedScale === "bit"}
                label="bit"
                value={address.bit}
              />
              <AddressMetric
                focused={selectedScale === "chunk"}
                label="part"
                value={address.part}
              />
              <AddressMetric
                focused={selectedScale === "chunk"}
                label="byte_in_part"
                value={address.byteInPart}
              />
              <AddressMetric
                focused={selectedScale === "chunk"}
                label="chunk_key"
                value={address.chunkKey}
                wide
              />
            </dl>
            <div
              aria-label="Address derivation"
              className="mt-5 flex flex-col gap-2 border-l border-primary/35 pl-4 font-mono text-base text-muted-foreground sm:text-sm"
            >
              <p>
                byte_in_row = floor({formatCount(address.x)} /{" "}
                {LIFE_WORKLOAD.bitsPerByte}) ={" "}
                <strong className="font-medium text-foreground">
                  {formatCount(address.byteInRow)}
                </strong>
              </p>
              <p>
                bit = {formatCount(address.x)} mod {LIFE_WORKLOAD.bitsPerByte} ={" "}
                <strong className="font-medium text-foreground">
                  {address.bit}
                </strong>
              </p>
              <p>
                part = byte_in_row &lt; {formatCount(LIFE_WORKLOAD.chunkBytes)}?
                0 : 1 ={" "}
                <strong className="font-medium text-foreground">
                  {address.part}
                </strong>
              </p>
              <p>
                byte_in_part ={" "}
                {address.part === 0
                  ? formatCount(address.byteInRow)
                  : `${formatCount(address.byteInRow)} - ${formatCount(LIFE_WORKLOAD.chunkBytes)}`}{" "}
                ={" "}
                <strong className="font-medium text-foreground">
                  {formatCount(address.byteInPart)}
                </strong>
              </p>
              <p>
                chunk_key = {formatCount(address.y)} ×{" "}
                {LIFE_WORKLOAD.chunksPerRow} + {address.part} ={" "}
                <strong className="font-medium text-foreground">
                  {formatCount(address.chunkKey)}
                </strong>
              </p>
            </div>
            <p className="mt-3 max-w-[48ch] text-pretty text-base text-muted-foreground sm:text-sm">
              The same chunk key exists in both banks. Its active or inactive
              role requires validated chain generation evidence.
            </p>
            <p
              role="status"
              aria-live="polite"
              className="sr-only"
            >{`Cell ${address.x}, ${address.y} maps to chunk ${address.chunkKey}, byte ${address.byteInPart}, bit ${address.bit}.`}</p>
          </div>
        </div>
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
    <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-1.5">
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

function AddressMetric({
  focused,
  label,
  value,
  wide = false,
}: {
  readonly focused: boolean;
  readonly label: string;
  readonly value: number;
  readonly wide?: boolean;
}) {
  return (
    <div
      className={cn(
        "border-t border-border py-3 first:border-t-0 odd:pr-3 even:border-l even:pl-3",
        wide && "col-span-2 border-l-0 pl-0 odd:pr-0",
        focused && "bg-warning/5",
      )}
      data-focused={focused ? "true" : undefined}
    >
      <dt className="font-mono text-base font-medium text-foreground sm:text-sm">
        {label}
      </dt>
      <dd className="font-mono text-lg text-warning tabular-nums">
        {formatCount(value)}
      </dd>
    </div>
  );
}

function StorageAtlas({
  address,
  selectedScale,
}: {
  readonly address: CellStorageAddress;
  readonly selectedScale: ScaleId;
}) {
  return (
    <section
      className="border-y border-border bg-canvas py-16 sm:py-20 lg:py-24"
      aria-labelledby="atlas-title"
    >
      <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3">
          <p className="font-mono text-base tracking-wide text-warning sm:text-sm">
            STORAGE ATLAS / TWO-BANK TOPOLOGY
          </p>
          <h2
            id="atlas-title"
            className="max-w-[35ch] text-balance text-4xl font-semibold tracking-tight"
          >
            Two persistent banks, one atomic handoff
          </h2>
          <p className="max-w-[58ch] text-pretty text-lg text-muted-foreground sm:text-base">
            Each field folds {WORLD_HEIGHT} canonical rows into a 100 × 100
            atlas. Initialization materializes Bank A; the first processed tick
            materializes Bank B. The fold shows storage order, not world
            geometry.
          </p>
        </div>
        <figure className="mt-10">
          <div className="grid gap-6 lg:grid-cols-2">
            <BankPanel
              address={address}
              bank="A"
              selectedScale={selectedScale}
            />
            <BankPanel
              address={address}
              bank="B"
              selectedScale={selectedScale}
            />
          </div>
          <figcaption className="mt-6 flex flex-wrap gap-x-8 gap-y-3 border-t border-border pt-5 text-base text-muted-foreground sm:text-sm">
            <span>
              <strong className="font-medium text-foreground">
                {formatCount(
                  LIFE_WORKLOAD.chunksPerBank * LIFE_WORKLOAD.persistentBanks,
                )}
              </strong>{" "}
              bank chunk values at steady state
            </span>
            <span>
              <strong className="font-medium text-foreground">
                {STEADY_STATE_BYTES}
              </strong>{" "}
              raw bank bytes total
            </span>
            <span>Roles alternate after each committed generation</span>
            <span>
              Selected row {formatCount(address.y)} / chunk key{" "}
              {formatCount(address.chunkKey)}
            </span>
            <span>
              The selected address is highlighted in both bank keyspaces
            </span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function BankPanel({
  address,
  bank,
  selectedScale,
}: {
  readonly address: CellStorageAddress;
  readonly bank: "A" | "B";
  readonly selectedScale: ScaleId;
}) {
  const titleId = useId();
  const gridId = `bank-${bank.toLowerCase()}-row-grid`;
  const fieldFocused = ["cell", "bit", "byte", "chunk", "row"].includes(
    selectedScale,
  );
  const atlasX = address.y % 100;
  const atlasY = Math.floor(address.y / 100);
  return (
    <div className="rounded-lg border border-border bg-panel p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h3
          id={titleId}
          className="text-balance text-2xl font-semibold tracking-tight"
        >
          Bank {bank}
        </h3>
        <div className="text-right font-mono text-base text-muted-foreground sm:text-sm">
          <p>{CHUNKS_PER_BANK} chunk keys</p>
          <p>Role unknown</p>
        </div>
      </div>
      <div className="relative mt-4 overflow-hidden rounded-md border border-border bg-background p-3">
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-labelledby={titleId}
          className="aspect-square w-full"
          shapeRendering="crispEdges"
        >
          <defs>
            <pattern
              id={gridId}
              width="1"
              height="1"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 1 0 L 0 0 0 1"
                className="fill-none stroke-primary/20 stroke-[0.08]"
              />
            </pattern>
          </defs>
          <rect width="100" height="100" className="fill-panel" />
          <rect width="100" height="100" fill={`url(#${gridId})`} />
          <rect
            data-testid={`bank-${bank.toLowerCase()}-selected-row`}
            x={atlasX}
            y={atlasY}
            width="1"
            height="1"
            className={cn(fieldFocused ? "fill-warning/80" : "fill-primary/35")}
          />
        </svg>
        <p className="absolute right-4 bottom-4 left-4 rounded-sm bg-background/90 px-2 py-1 font-mono text-base text-foreground backdrop-blur-sm sm:text-sm">
          {fieldFocused
            ? `Row ${formatCount(address.y)} / ${selectedScale} focus`
            : `Row ${formatCount(address.y)} / ${selectedScale} context`}
        </p>
      </div>
      <div className="mt-4 grid grid-cols-[4fr_1fr] gap-1 font-mono text-base sm:text-sm">
        <div
          aria-current={address.part === 0 ? "true" : undefined}
          className={cn(
            "border-t-2 pt-2",
            address.part === 0
              ? "border-warning bg-warning/5"
              : "border-primary",
          )}
        >
          <p className="text-foreground">
            {address.part === 0 ? "Selected · " : ""}Part 0
          </p>
          <p className="text-muted-foreground">
            {formatCount(LIFE_WORKLOAD.chunkBytes)} bytes
          </p>
        </div>
        <div
          aria-current={address.part === 1 ? "true" : undefined}
          className={cn(
            "border-t-2 pt-2 pl-2",
            address.part === 1
              ? "border-warning bg-warning/5"
              : "border-primary",
          )}
        >
          <p className="text-foreground">
            {address.part === 1 ? "Selected · " : ""}Part 1
          </p>
          <p className="text-muted-foreground">
            {formatCount(LIFE_WORKLOAD.tailBytes)} bytes
          </p>
        </div>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4">
        <div>
          <dt className="text-base text-muted-foreground sm:text-sm">Rows</dt>
          <dd className="font-mono text-lg tabular-nums">{WORLD_HEIGHT}</dd>
        </div>
        <div>
          <dt className="text-base text-muted-foreground sm:text-sm">
            Payload
          </dt>
          <dd className="font-mono text-lg tabular-nums">{BANK_BYTES} B</dd>
        </div>
      </dl>
    </div>
  );
}
