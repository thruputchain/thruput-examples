import { useEffect, useId, useRef, useState } from "react";
import { Focus, Minus, Plus, RotateCcw } from "lucide-react";
import type { ImmutableSnapshot, IndexerClient } from "@/indexer/client";
import type { RendererAvailability } from "@/synchronization";
import { Button } from "@/components/ui/button";
import {
  MAX_CAMERA_ZOOM,
  MIN_CAMERA_ZOOM,
  type Camera,
} from "@/renderer/camera";
import type { Inspection } from "@/renderer/inspection";
import { renderingMode, scaleRuler } from "@/renderer/viewport-presentation";
import {
  WorldRenderer,
  type CandidateIdentity,
  type CellHighlight,
} from "@/renderer/world-renderer";

interface Props {
  readonly client: IndexerClient;
  readonly initialSnapshot: ImmutableSnapshot;
  readonly initialIdentity: CandidateIdentity | null;
  readonly candidate: ImmutableSnapshot | null;
  readonly candidateEpoch: number | null;
  readonly onTransition: (state: "staging" | "crossfading" | "idle") => void;
  readonly approveCommit: (
    snapshot: ImmutableSnapshot,
    identity: CandidateIdentity,
  ) => boolean;
  readonly onAnnouncement: (message: string) => void;
  readonly onAvailability: (value: RendererAvailability) => void;
}
const INITIAL_CAMERA: Camera = { x: 5_000, y: 5_000, zoom: -6 };

export function WorldViewport({
  client,
  initialSnapshot,
  initialIdentity,
  candidate,
  candidateEpoch,
  onTransition,
  approveCommit,
  onAnnouncement,
  onAvailability,
}: Props) {
  const section = useRef<HTMLElement>(null);
  const canvasDescription = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<WorldRenderer>(null);
  const mountedSnapshot = useRef(initialSnapshot);
  const mountedIdentity = useRef(initialIdentity);
  const lifecycle = useRef({
    onTransition,
    approveCommit,
    onAnnouncement,
    onAvailability,
  });
  lifecycle.current = {
    onTransition,
    approveCommit,
    onAnnouncement,
    onAvailability,
  };
  const [camera, setCamera] = useState(INITIAL_CAMERA);
  const [level, setLevel] = useState(0);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [cellHighlight, setCellHighlight] = useState<CellHighlight | null>(
    null,
  );
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [tileWarning, setTileWarning] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });

  useEffect(() => {
    if (!section.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setViewport({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    observer.observe(section.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canvas.current) return;
    try {
      renderer.current = new WorldRenderer(
        canvas.current,
        client,
        mountedSnapshot.current,
        {
          onCamera: setCamera,
          onLevel: setLevel,
          onInspect: (value, announce, highlight) => {
            setInspection(value);
            setCellHighlight(highlight);
            if (announce && value)
              lifecycle.current.onAnnouncement(inspectionLabel(value));
            else if (!value) lifecycle.current.onAnnouncement("");
          },
          onError: setTileWarning,
          onContext: (lost) => {
            setContextLost(lost);
            lifecycle.current.onAvailability(
              lost ? "context-lost" : "available",
            );
          },
          onTransition: (value) => lifecycle.current.onTransition(value),
          approveSnapshotCommit: (value, identity) =>
            lifecycle.current.approveCommit(value, identity),
        },
        mountedIdentity.current,
      );
      lifecycle.current.onAvailability("available");
    } catch (cause) {
      setFatalError(
        cause instanceof Error ? cause.message : "Renderer failed to start",
      );
      lifecycle.current.onAvailability("unavailable");
    }
    return () => {
      renderer.current?.destroy();
      renderer.current = null;
    };
  }, [client]);

  useEffect(() => {
    if (candidate && candidateEpoch !== null)
      renderer.current?.stageSnapshot(candidate, client, candidateEpoch);
    else renderer.current?.cancelCandidate();
  }, [candidate, candidateEpoch, client]);

  const controlsDisabled = fatalError !== null || contextLost;
  const ruler = scaleRuler(camera.zoom);
  const highlight = camera.zoom >= 2 ? cellHighlight : null;

  return (
    <section
      ref={section}
      className="relative min-h-0 flex-1 overflow-hidden bg-canvas"
      aria-label="Interactive Game of Life world"
      tabIndex={controlsDisabled ? -1 : 0}
      aria-describedby={canvasDescription}
      onKeyDown={(event) => {
        if (event.currentTarget === event.target)
          renderer.current?.handleKey(event.nativeEvent);
      }}
    >
      <canvas
        ref={canvas}
        tabIndex={-1}
        aria-label="Pan and zoom the 10,000 by 10,000 cell world"
        className="size-full touch-none"
      />
      {highlight ? (
        <span
          aria-hidden="true"
          data-testid="cell-highlight"
          className="pointer-events-none absolute border border-primary bg-primary/15 shadow-[0_0_12px_color-mix(in_oklab,var(--primary)_45%,transparent)]"
          style={{
            left: highlight.left,
            top: highlight.top,
            width: highlight.width,
            height: highlight.height,
          }}
        />
      ) : null}
      <p id={canvasDescription} className="sr-only">
        Use the mouse wheel or plus and minus keys to zoom, drag or arrow keys
        to pan, zero to fit the world, and Enter to inspect the viewport center.
      </p>
      {fatalError ? (
        <div className="absolute inset-0 grid place-items-center bg-canvas/90 p-6">
          <div className="max-w-[46ch] rounded-lg border border-border bg-panel p-5 text-center">
            <h2 className="text-balance text-lg font-semibold">
              Visualization unavailable
            </h2>
            <p className="mt-2 text-pretty text-base text-muted-foreground sm:text-sm">
              {fatalError}
            </p>
            <p className="mt-2 text-pretty text-base text-muted-foreground sm:text-sm">
              Snapshot metadata and provenance remain available in world
              details.
            </p>
          </div>
        </div>
      ) : null}
      {tileWarning && !fatalError ? (
        <div
          role="status"
          className="absolute top-[calc(var(--safe-top)+8rem)] right-[max(.75rem,var(--safe-right))] left-[max(.75rem,var(--safe-left))] rounded-md border border-warning/40 bg-panel/95 px-3 py-2 text-base text-warning sm:left-auto sm:text-sm"
        >
          {tileWarning}
        </div>
      ) : null}
      {contextLost ? (
        <div
          role="status"
          className="absolute top-[calc(var(--safe-top)+4.5rem)] right-[max(.75rem,var(--safe-right))] left-[max(.75rem,var(--safe-left))] rounded-md border border-border bg-panel px-3 py-2 text-base sm:text-sm"
        >
          WebGL context lost. Waiting for restoration.
        </div>
      ) : null}
      <div className="absolute top-[calc(var(--safe-top)+4.5rem)] left-[max(.75rem,var(--safe-left))] max-w-[calc(100%-1.5rem)] rounded-md border border-border bg-panel/95 px-3 py-2 font-mono text-sm shadow-sm backdrop-blur-md sm:left-[max(1rem,var(--safe-left))]">
        {inspection ? (
          inspection.kind === "cell" ? (
            <span>
              Generation {inspection.generation} · exact cell x {inspection.x} ·
              y {inspection.y} ·{" "}
              <strong>{inspection.alive ? "live" : "dead"}</strong>
            </span>
          ) : (
            <span>
              Generation {inspection.generation} · {inspection.width} ×{" "}
              {inspection.height} region · x {inspection.x}–
              {inspection.x + inspection.width - 1} · y {inspection.y}–
              {inspection.y + inspection.height - 1} ·{" "}
              <strong>{inspection.live.toLocaleString()}</strong> /{" "}
              {inspection.covered.toLocaleString()} alive ·{" "}
              {formatPercentage(inspection.live, inspection.covered)}
            </span>
          )
        ) : (
          <span className="text-muted-foreground">
            Move over a loaded tile to inspect
          </span>
        )}
      </div>
      <div className="absolute right-[max(.75rem,var(--safe-right))] bottom-[max(.75rem,var(--safe-bottom))] flex items-end gap-3">
        <Minimap camera={camera} viewport={viewport} />
        <div
          role="group"
          className="flex rounded-md border border-border bg-panel/95 p-1 shadow-sm backdrop-blur-md"
          aria-label="World controls"
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-12 sm:size-9 [@media(pointer:coarse)]:size-12"
            aria-label="Zoom out"
            disabled={controlsDisabled || camera.zoom <= MIN_CAMERA_ZOOM}
            onClick={() => renderer.current?.zoom(-0.5)}
          >
            <Minus />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-12 sm:size-9 [@media(pointer:coarse)]:size-12"
            aria-label="Zoom in"
            disabled={controlsDisabled || camera.zoom >= MAX_CAMERA_ZOOM}
            onClick={() => renderer.current?.zoom(0.5)}
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-12 sm:size-9 [@media(pointer:coarse)]:size-12"
            aria-label="Fit world"
            disabled={controlsDisabled}
            onClick={() => renderer.current?.fit()}
          >
            <Focus />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-12 sm:size-9 [@media(pointer:coarse)]:size-12"
            aria-label="Reset north-up"
            disabled={controlsDisabled}
            onClick={() => renderer.current?.reset()}
          >
            <RotateCcw />
          </Button>
        </div>
      </div>
      <div
        aria-label="World scale and rendering mode"
        className="absolute bottom-[calc(var(--safe-bottom)+4.5rem)] left-[max(.75rem,var(--safe-left))] w-fit rounded-md border border-border bg-panel/95 px-3 py-2 font-mono text-base backdrop-blur-md sm:bottom-[max(.75rem,var(--safe-bottom))] sm:text-sm"
        style={{
          maxWidth:
            "calc(100% - max(.75rem, var(--safe-left)) - max(.75rem, var(--safe-right)))",
        }}
      >
        <div className="text-muted-foreground">
          {renderingMode(level, camera.zoom)}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span
            className="block h-px bg-primary"
            style={{ width: ruler.pixels }}
          />
          <span>{ruler.label}</span>
        </div>
      </div>
    </section>
  );
}

function inspectionLabel(value: Inspection): string {
  return value.kind === "cell"
    ? `Generation ${value.generation}, cell ${value.x}, ${value.y} is ${value.alive ? "live" : "dead"}`
    : `Generation ${value.generation}, ${value.width} by ${value.height} region from ${value.x}, ${value.y}, ${value.live} of ${value.covered} cells are alive`;
}

function Minimap({
  camera,
  viewport,
}: {
  readonly camera: Camera;
  readonly viewport: { readonly width: number; readonly height: number };
}) {
  const scale = 2 ** camera.zoom;
  const width = Math.min(100, (100 * viewport.width) / scale / 10_000);
  const height = Math.min(100, (100 * viewport.height) / scale / 10_000);
  const left = Math.max(0, Math.min(100 - width, camera.x / 100 - width / 2));
  const top = Math.max(0, Math.min(100 - height, camera.y / 100 - height / 2));
  return (
    <div
      className="relative hidden size-24 overflow-hidden rounded-md border border-border bg-panel/95 sm:block"
      aria-label="World minimap"
    >
      <div className="absolute inset-2 bg-[radial-gradient(circle_at_30%_30%,var(--primary),transparent_2px)] bg-[length:8px_8px] opacity-35" />
      <div
        className="absolute border border-primary bg-primary/10"
        style={{
          left: `${left}%`,
          top: `${top}%`,
          width: `${width}%`,
          height: `${height}%`,
        }}
      />
    </div>
  );
}
function formatPercentage(live: number, covered: number): string {
  return `${((live / covered) * 100).toFixed(1)}%`;
}
