import {
  Deck,
  OrthographicView,
  OrthographicViewport,
  type ViewStateChangeParameters,
} from "@deck.gl/core";
import type { NonGeoBoundingBox } from "@deck.gl/geo-layers";
import type { ImmutableSnapshot, IndexerClient } from "@/indexer/client";
import { WORLD_SIZE } from "@/indexer/schema";
import {
  ActiveByteBudget,
  CPU_CACHE_BUDGET,
  DEFAULT_GPU_BUDGET,
} from "./budget";
import {
  clampCamera,
  fitCamera,
  parseCamera,
  serializeCamera,
  type Camera,
} from "./camera";
import { inspect, type Inspection } from "./inspection";
import { clippedBounds, LifeTileTextureLayer } from "./life-tile-layer";
import { LifeTileLayer, LifeTileset } from "./life-tileset";
import {
  immediateParentRefinement,
  parentIndex,
  ring,
  tileId,
  worldToTile,
  type RefinementTile,
  type TileIndex,
} from "./pyramid";
import { TileLoader, type TileData } from "./tile-loader";
import { UnavailableTileLayer } from "./unavailable-tile-layer";

export interface RendererCallbacks {
  onCamera(camera: Camera): void;
  onInspect(value: Inspection | null): void;
  onError(message: string): void;
  onContext(lost: boolean): void;
}
export class WorldRenderer {
  readonly loader: TileLoader;
  readonly gpu = new ActiveByteBudget(DEFAULT_GPU_BUDGET);
  private deck: Deck<OrthographicView> | null = null;
  private camera: Camera;
  private resize: ResizeObserver;
  private selectedLevel = 0;
  private selectionKey = "";
  private prefetchController: AbortController | null = null;
  private idleCallback = 0;
  private inspectTimer = 0;
  private cameraTimer = 0;
  private destroyed = false;
  private readonly listeners: Array<() => void> = [];
  constructor(
    private readonly canvas: HTMLCanvasElement,
    client: IndexerClient,
    private readonly snapshot: ImmutableSnapshot,
    private readonly callbacks: RendererCallbacks,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: true,
    });
    if (!gl)
      throw new Error("WebGL2 is unavailable; metadata remains available.");
    this.camera =
      parseCamera(location.search) ??
      fitCamera(canvas.clientWidth || 800, canvas.clientHeight || 600);
    this.camera = clampCamera(
      this.camera,
      canvas.clientWidth || 800,
      canvas.clientHeight || 600,
    );
    this.loader = new TileLoader(
      client,
      snapshot,
      undefined,
      (...args) => globalThis.fetch(...args),
      CPU_CACHE_BUDGET,
    );
    this.resize = new ResizeObserver(() => this.resized());
    this.listen("pointermove", (event) => this.pointer(event as PointerEvent));
    this.listen("pointerleave", () => {
      clearTimeout(this.inspectTimer);
      callbacks.onInspect(null);
    });
    this.listen("webglcontextlost", (event) => this.contextLost(event), true);
    this.listen("webglcontextrestored", () => this.contextRestored(), true);
    this.listen("keydown", (event) => this.key(event as KeyboardEvent), true);
    try {
      this.createDeck();
      this.resize.observe(canvas);
      callbacks.onCamera(this.camera);
    } catch (cause) {
      this.resize.disconnect();
      for (const remove of this.listeners.splice(0)) remove();
      this.loader.close();
      throw cause;
    }
  }
  private createDeck(): void {
    this.deck = new Deck({
      canvas: this.canvas,
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      views: new OrthographicView({
        id: "life",
        flipY: true,
        controller: {
          dragRotate: false,
          touchRotate: false,
          maxBounds: [
            [0, 0],
            [WORLD_SIZE, WORLD_SIZE],
          ],
          scrollZoom: { smooth: true },
        },
      }),
      viewState: {
        target: [this.camera.x, this.camera.y, 0],
        zoom: this.camera.zoom,
      },
      layers: [this.layer()],
      onViewStateChange: (event) => {
        this.viewChanged(event);
      },
      onError: (error) => this.callbacks.onError(error.message),
    });
  }
  zoom(delta: number): void {
    this.setCamera({
      ...this.camera,
      zoom: Math.min(0, Math.max(-6, this.camera.zoom + delta)),
    });
  }
  fit(): void {
    this.setCamera(
      fitCamera(this.canvas.clientWidth, this.canvas.clientHeight),
    );
  }
  reset(): void {
    this.setCamera({ x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, zoom: -6 });
  }
  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.inspectTimer);
    clearTimeout(this.cameraTimer);
    this.cancelPrefetch();
    this.resize.disconnect();
    for (const remove of this.listeners) remove();
    this.deck?.finalize();
    this.deck = null;
    this.loader.close();
  }
  private layer(): LifeTileLayer<TileData> {
    const digest = this.snapshot.manifest.stateDigest;
    return new LifeTileLayer<TileData>({
      id: `life-${digest}`,
      data: this.snapshot.manifestUrl.href,
      TilesetClass: LifeTileset,
      extent: [0, 0, WORLD_SIZE, WORLD_SIZE],
      tileSize: 16_384,
      minZoom: 0,
      maxZoom: 6,
      zoomOffset: 6,
      maxRequests: 7,
      maxCacheByteSize: CPU_CACHE_BUDGET,
      onSelection: (level, visible) => this.selectionChanged(level, visible),
      getTileData: ({ index, signal }) =>
        this.loader.load(index, signal).then((data) => {
          if (data.availability === "missing")
            this.callbacks.onError("Tile unavailable; showing diagonal hatch");
          return data;
        }),
      refinementStrategy: (tiles) =>
        immediateParentRefinement(tiles as unknown as RefinementTile[], digest),
      onTileError: (error) => this.callbacks.onError(error.message),
      renderSubLayers: (props) => {
        if (!props.data) return null;
        const bounds = clippedBounds(props.tile.bbox as NonGeoBoundingBox);
        if (props.data.availability === "missing")
          return new UnavailableTileLayer(props, {
            id: `${props.id}-unavailable`,
            bounds,
            gpuBudget: this.gpu,
            pickable: false,
          });
        return new LifeTileTextureLayer(props, {
          id: `${props.id}-texture`,
          bounds,
          content: props.data,
          gpuBudget: this.gpu,
          pickable: false,
        });
      },
    });
  }
  private setCamera(camera: Camera): void {
    this.camera = clampCamera(
      camera,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
    );
    this.deck?.setProps({
      viewState: {
        target: [this.camera.x, this.camera.y, 0],
        zoom: this.camera.zoom,
      },
    });
    this.publishCamera();
  }
  private viewChanged({
    viewState,
    interactionState,
  }: ViewStateChangeParameters) {
    const target = viewState.target ?? [this.camera.x, this.camera.y, 0];
    this.camera = clampCamera(
      {
        x: Number(target[0]),
        y: Number(target[1]),
        zoom: Number(viewState.zoom),
      },
      this.canvas.clientWidth,
      this.canvas.clientHeight,
    );
    const controlled = {
      target: [this.camera.x, this.camera.y, 0] as [number, number, number],
      zoom: this.camera.zoom,
    };
    this.deck?.setProps({ viewState: controlled });
    if (Object.values(interactionState).some(Boolean)) this.publishCamera();
  }
  private publishCamera(): void {
    clearTimeout(this.cameraTimer);
    this.cameraTimer = window.setTimeout(() => {
      this.callbacks.onCamera(this.camera);
      history.replaceState(null, "", serializeCamera(this.camera));
    }, 120);
  }
  private pointer(event: PointerEvent): void {
    clearTimeout(this.inspectTimer);
    this.inspectTimer = window.setTimeout(() => {
      const rect = this.canvas.getBoundingClientRect();
      this.inspectScreen(event.clientX - rect.left, event.clientY - rect.top);
    }, 80);
  }
  private key(event: KeyboardEvent): void {
    const step = 300 / 2 ** this.camera.zoom;
    if (["+", "="].includes(event.key)) {
      event.preventDefault();
      this.zoom(0.5);
    } else if (event.key === "-") {
      event.preventDefault();
      this.zoom(-0.5);
    } else if (event.key === "0") {
      event.preventDefault();
      this.fit();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.inspectScreen(
        this.canvas.clientWidth / 2,
        this.canvas.clientHeight / 2,
      );
    } else if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      this.setCamera({
        ...this.camera,
        x:
          this.camera.x +
          (event.key === "ArrowRight"
            ? step
            : event.key === "ArrowLeft"
              ? -step
              : 0),
        y:
          this.camera.y +
          (event.key === "ArrowDown"
            ? step
            : event.key === "ArrowUp"
              ? -step
              : 0),
      });
    }
  }
  private listen(type: string, handler: EventListener, capture = false): void {
    this.canvas.addEventListener(type, handler, capture);
    this.listeners.push(() =>
      this.canvas.removeEventListener(type, handler, capture),
    );
  }
  private resized(): void {
    this.camera = clampCamera(
      this.camera,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
    );
    this.deck?.setProps({
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      viewState: {
        target: [this.camera.x, this.camera.y, 0],
        zoom: this.camera.zoom,
      },
    });
  }
  private contextLost(event: Event): void {
    event.preventDefault();
    this.callbacks.onContext(true);
    this.cancelPrefetch();
    const deck = this.deck;
    this.deck = null;
    deck?.finalize();
  }
  private contextRestored(): void {
    if (this.destroyed) return;
    try {
      this.createDeck();
      this.callbacks.onContext(false);
    } catch (cause) {
      this.callbacks.onError(
        cause instanceof Error ? cause.message : "Renderer restoration failed",
      );
    }
  }
  private selectionChanged(level: number, visible: readonly TileIndex[]): void {
    this.selectedLevel = level;
    const key = `${level}:${visible.map(tileId).sort().join(",")}`;
    if (key === this.selectionKey) return;
    this.selectionKey = key;
    this.cancelPrefetch();
    const visibleIds = new Set(visible.map(tileId));
    const candidates = ring(visible).filter(
      (index) => !visibleIds.has(tileId(index)),
    );
    if (!candidates.length) return;
    const controller = new AbortController();
    this.prefetchController = controller;
    this.idleCallback = requestIdle(() => {
      this.idleCallback = 0;
      void this.loader
        .prefetch(candidates, controller.signal)
        .catch(() => undefined);
    });
  }
  private cancelPrefetch(): void {
    if (this.idleCallback) cancelIdle(this.idleCallback);
    this.idleCallback = 0;
    this.prefetchController?.abort();
    this.prefetchController = null;
  }
  private cacheKey(index: TileIndex): string {
    return `${this.snapshot.manifest.stateDigest}:${tileId(index)}`;
  }
  private inspectScreen(screenX: number, screenY: number): void {
    const viewport = this.deck?.getViewports()[0];
    if (!(viewport instanceof OrthographicViewport)) return;
    const world = viewport.unproject([screenX, screenY]);
    const x = Math.floor(world[0]!);
    const y = Math.floor(world[1]!);
    if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE)
      return this.callbacks.onInspect(null);
    const mapped = worldToTile(x, y, this.selectedLevel);
    let data = this.loader.cache.get(this.cacheKey(mapped.tile));
    if (!data) {
      const parent = parentIndex(mapped.tile);
      if (parent) data = this.loader.cache.get(this.cacheKey(parent));
    }
    this.callbacks.onInspect(
      data?.availability === "loaded"
        ? inspect(
            data.tile,
            x,
            y,
            data.index.z,
            this.snapshot.manifest.generation,
          )
        : null,
    );
  }
}

function requestIdle(callback: () => void): number {
  if (typeof window.requestIdleCallback === "function")
    return window.requestIdleCallback(callback, { timeout: 500 });
  return window.setTimeout(callback, 100);
}

function cancelIdle(id: number): void {
  if (typeof window.cancelIdleCallback === "function")
    window.cancelIdleCallback(id);
  else clearTimeout(id);
}
