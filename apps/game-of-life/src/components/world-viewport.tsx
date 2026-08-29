import { useEffect, useId, useRef, useState } from "react";
import { Focus, Minus, Plus, RotateCcw } from "lucide-react";
import type { ImmutableSnapshot, IndexerClient } from "@/indexer/client";
import { Button } from "@/components/ui/button";
import type { Camera } from "@/renderer/camera";
import type { Inspection } from "@/renderer/inspection";
import { WorldRenderer } from "@/renderer/world-renderer";

interface Props {
  readonly client: IndexerClient;
  readonly snapshot: ImmutableSnapshot;
}
const INITIAL_CAMERA: Camera = { x: 5_000, y: 5_000, zoom: -6 };

export function WorldViewport({ client, snapshot }: Props) {
  const section = useRef<HTMLElement>(null);
  const canvasDescription = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<WorldRenderer>(null);
  const [camera, setCamera] = useState(INITIAL_CAMERA);
  const [inspection, setInspection] = useState<Inspection | null>(null);
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
      renderer.current = new WorldRenderer(canvas.current, client, snapshot, {
        onCamera: setCamera,
        onInspect: setInspection,
        onError: setTileWarning,
        onContext: setContextLost,
      });
    } catch (cause) {
      setFatalError(
        cause instanceof Error ? cause.message : "Renderer failed to start",
      );
    }
    return () => {
      renderer.current?.destroy();
      renderer.current = null;
    };
  }, [client, snapshot]);

  return (
    <section
      ref={section}
      className="relative min-h-0 flex-1 overflow-hidden bg-canvas"
      aria-label="Interactive Game of Life world"
    >
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label="Pan and zoom the 10,000 by 10,000 cell world"
        aria-describedby={canvasDescription}
        className="size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <p id={canvasDescription} className="sr-only">
        Use the mouse wheel or plus and minus keys to zoom, drag or arrow keys
        to pan, zero to fit the world, and Enter to inspect the viewport center.
      </p>
      {fatalError ? (
        <div
          role="status"
          className="absolute inset-0 grid place-items-center bg-canvas/90 p-6"
        >
          <div className="max-w-[46ch] rounded-lg border border-border bg-panel p-5 text-center">
            <h2 className="text-balance text-lg font-semibold">
              Visualization unavailable
            </h2>
            <p className="mt-2 text-pretty text-base text-muted-foreground sm:text-sm">
              {fatalError}
            </p>
            <p className="mt-2 text-pretty text-base text-muted-foreground sm:text-sm">
              Snapshot metadata and provenance remain available above.
            </p>
          </div>
        </div>
      ) : null}
      {tileWarning && !fatalError ? (
        <div
          role="status"
          className="absolute inset-x-3 top-16 rounded-md border border-warning/40 bg-panel/95 px-3 py-2 text-base text-warning sm:inset-x-auto sm:right-3 sm:text-sm"
        >
          {tileWarning}
        </div>
      ) : null}
      {contextLost ? (
        <div
          role="status"
          className="absolute inset-x-4 top-4 rounded-md border border-border bg-panel px-3 py-2 text-base sm:text-sm"
        >
          WebGL context lost. Waiting for restoration.
        </div>
      ) : null}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="absolute top-3 left-3 rounded-md border border-border bg-panel/95 px-3 py-2 font-mono text-sm shadow-sm backdrop-blur-md"
      >
        {inspection ? (
          inspection.kind === "cell" ? (
            <span>
              Generation {inspection.generation} · exact cell x {inspection.x} ·
              y {inspection.y} ·{" "}
              <strong>{inspection.alive ? "live" : "dead"}</strong>
            </span>
          ) : (
            <span>
              Generation {inspection.generation} · aggregate at x {inspection.x}
              · y {inspection.y} ·{" "}
              <strong>{inspection.live.toLocaleString()}</strong> /{" "}
              {inspection.covered.toLocaleString()} cells live
            </span>
          )
        ) : (
          <span className="text-muted-foreground">
            Move over a loaded tile to inspect
          </span>
        )}
      </div>
      <div className="absolute right-3 bottom-3 flex items-end gap-3">
        <Minimap camera={camera} viewport={viewport} />
        <div
          role="group"
          className="flex rounded-md border border-border bg-panel/95 p-1 shadow-sm backdrop-blur-md"
          aria-label="World controls"
        >
          <Button
            variant="ghost"
            size="icon"
            className="[@media(pointer:coarse)]:size-12"
            aria-label="Zoom out"
            onClick={() => renderer.current?.zoom(-0.5)}
          >
            <Minus />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="[@media(pointer:coarse)]:size-12"
            aria-label="Zoom in"
            onClick={() => renderer.current?.zoom(0.5)}
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="[@media(pointer:coarse)]:size-12"
            aria-label="Fit world"
            onClick={() => renderer.current?.fit()}
          >
            <Focus />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="[@media(pointer:coarse)]:size-12"
            aria-label="Reset north-up"
            onClick={() => renderer.current?.reset()}
          >
            <RotateCcw />
          </Button>
        </div>
      </div>
      <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-md border border-border bg-panel/95 px-3 py-2 font-mono text-sm backdrop-blur-md">
        <span className="block h-px w-12 bg-primary" />{" "}
        {scaleLabel(camera.zoom, 48)}
      </div>
    </section>
  );
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
function scaleLabel(zoom: number, pixels: number): string {
  const cells = Math.max(1, Math.round(pixels / 2 ** zoom));
  return `${cells.toLocaleString()} cells`;
}
