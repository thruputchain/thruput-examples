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
  DECK_LAYER_CACHE_BUDGET,
  DEFAULT_GPU_BUDGET,
  SHARED_CPU_CACHE_BUDGET,
} from "./budget";
import {
  clampCamera,
  fitCamera,
  MAX_CAMERA_ZOOM,
  MIN_CAMERA_ZOOM,
  parseCamera,
  serializeCamera,
  type Camera,
} from "./camera";
import { inspect, type Inspection } from "./inspection";
import { hasRequiredCoverage } from "./coverage";
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
import {
  createTileResources,
  TileLoader,
  type TileData,
  type TileResources,
} from "./tile-loader";
import { UnavailableTileLayer } from "./unavailable-tile-layer";

export interface RendererCallbacks {
  onCamera(camera: Camera): void;
  onLevel(level: number): void;
  onInspect(
    value: Inspection | null,
    announce: boolean,
    highlight: CellHighlight | null,
  ): void;
  onError(message: string): void;
  onContext(lost: boolean): void;
  onTransition(state: "staging" | "crossfading" | "idle"): void;
  approveSnapshotCommit(
    snapshot: ImmutableSnapshot,
    identity: CandidateIdentity,
  ): boolean;
}
export interface CellHighlight {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export interface CandidateIdentity {
  readonly epoch: number;
  readonly digest: string;
}
interface Selection {
  readonly level: number;
  readonly tiles: readonly TileIndex[];
  readonly key: string;
}
const EMPTY_SELECTION: Selection = { level: 0, tiles: [], key: "" };

export class WorldRenderer {
  readonly gpu = new ActiveByteBudget(DEFAULT_GPU_BUDGET);
  private readonly resources: TileResources;
  private displayed: ImmutableSnapshot;
  private displayedLoader: TileLoader;
  private candidate: ImmutableSnapshot | null = null;
  private candidateEpoch: number | null = null;
  private candidateLoader: TileLoader | null = null;
  private deck: Deck<OrthographicView> | null = null;
  private camera: Camera;
  private resize: ResizeObserver;
  private readonly tabIndexObserver: MutationObserver;
  private displayedSelection = EMPTY_SELECTION;
  private candidateSelection = EMPTY_SELECTION;
  private readonly renderReady = new Map<string, number>();
  private renderFrame = 0;
  private coverageReadyFrame: number | null = null;
  private commitAfterFrame: number | null = null;
  private prefetchController: AbortController | null = null;
  private idleCallback = 0;
  private inspectTimer = 0;
  private pointerClientPosition: readonly [number, number] | null = null;
  private cameraTimer = 0;
  private transitionFrame = 0;
  private transitionStarted = 0;
  private candidateOpacity = 0;
  private initialIdentity: CandidateIdentity | null;
  private initialOpacity: 0 | 1;
  private initialCoverageReadyFrame: number | null = null;
  private initialCommitAfterFrame: number | null = null;
  private destroyed = false;
  private readonly listeners: Array<() => void> = [];
  constructor(
    private readonly canvas: HTMLCanvasElement,
    client: IndexerClient,
    snapshot: ImmutableSnapshot,
    private readonly callbacks: RendererCallbacks,
    initialIdentity: CandidateIdentity | null = null,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: true,
    });
    if (!gl)
      throw new Error("WebGL2 is unavailable; metadata remains available.");
    this.displayed = snapshot;
    this.initialIdentity = initialIdentity;
    this.initialOpacity = initialIdentity ? 0 : 1;
    this.resources = createTileResources(SHARED_CPU_CACHE_BUDGET);
    this.displayedLoader = new TileLoader(
      client,
      snapshot,
      undefined,
      (...args) => globalThis.fetch(...args),
      SHARED_CPU_CACHE_BUDGET,
      this.resources,
    );
    this.camera =
      parseCamera(location.search) ??
      fitCamera(canvas.clientWidth || 800, canvas.clientHeight || 600);
    this.camera = clampCamera(
      this.camera,
      canvas.clientWidth || 800,
      canvas.clientHeight || 600,
    );
    this.resize = new ResizeObserver(() => this.resized());
    this.tabIndexObserver = new MutationObserver(() => {
      if (canvas.tabIndex !== -1) canvas.tabIndex = -1;
    });
    this.tabIndexObserver.observe(canvas, {
      attributes: true,
      attributeFilter: ["tabindex"],
    });
    this.listen("pointermove", (event) => this.pointer(event as PointerEvent));
    this.listen("pointerleave", () => {
      clearTimeout(this.inspectTimer);
      this.pointerClientPosition = null;
      callbacks.onInspect(null, false, null);
    });
    this.listen("webglcontextlost", (event) => this.contextLost(event), true);
    this.listen("webglcontextrestored", () => this.contextRestored(), true);
    this.listen("keydown", (event) => this.key(event as KeyboardEvent), true);
    try {
      this.createDeck();
      this.canvas.tabIndex = -1;
      this.resize.observe(canvas);
      callbacks.onCamera(this.camera);
    } catch (cause) {
      this.resize.disconnect();
      this.tabIndexObserver.disconnect();
      for (const remove of this.listeners.splice(0)) remove();
      this.displayedLoader.close();
      this.resources.pool.close();
      this.resources.cache.clear();
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
      layers: this.layers(),
      onViewStateChange: (event) => {
        this.viewChanged(event);
      },
      onError: (error) => this.callbacks.onError(error.message),
      onAfterRender: () => this.afterRender(),
    });
  }
  zoom(delta: number): void {
    this.setCamera({
      ...this.camera,
      zoom: Math.min(
        MAX_CAMERA_ZOOM,
        Math.max(MIN_CAMERA_ZOOM, this.camera.zoom + delta),
      ),
    });
  }
  fit(): void {
    this.setCamera(
      fitCamera(this.canvas.clientWidth, this.canvas.clientHeight),
    );
  }
  reset(): void {
    this.setCamera({
      x: WORLD_SIZE / 2,
      y: WORLD_SIZE / 2,
      zoom: MIN_CAMERA_ZOOM,
    });
  }
  handleKey(event: KeyboardEvent): void {
    this.key(event);
  }
  stageSnapshot(
    snapshot: ImmutableSnapshot,
    client: IndexerClient,
    epoch: number,
  ): void {
    if (this.destroyed) return;
    const displayedGeneration = BigInt(this.displayed.manifest.generation);
    const nextGeneration = BigInt(snapshot.manifest.generation);
    if (nextGeneration < displayedGeneration) return;
    if (nextGeneration === displayedGeneration) {
      if (
        snapshot.manifest.stateDigest !== this.displayed.manifest.stateDigest
      ) {
        this.cancelCandidate();
        this.callbacks.onError(
          "Indexer returned conflicting digests for the visualized generation",
        );
      }
      return;
    }
    if (this.candidate) {
      const candidateGeneration = BigInt(this.candidate.manifest.generation);
      if (nextGeneration < candidateGeneration) return;
      if (nextGeneration === candidateGeneration) {
        if (
          snapshot.manifest.stateDigest !== this.candidate.manifest.stateDigest
        ) {
          this.cancelCandidate();
          this.callbacks.onError(
            "Indexer returned conflicting digests for the candidate generation",
          );
        }
        return;
      }
    }
    this.cancelCandidate();
    this.candidate = snapshot;
    this.candidateEpoch = epoch;
    this.candidateLoader = new TileLoader(
      client,
      snapshot,
      undefined,
      (...args) => globalThis.fetch(...args),
      SHARED_CPU_CACHE_BUDGET,
      this.resources,
    );
    this.candidateOpacity = 0;
    this.candidateSelection = EMPTY_SELECTION;
    this.coverageReadyFrame = null;
    this.callbacks.onTransition("staging");
    this.updateLayers();
    this.evaluateCoverage();
  }
  cancelCandidate(expected?: CandidateIdentity): void {
    if (!this.candidate || !this.candidateLoader) return;
    if (
      expected &&
      (expected.epoch !== this.candidateEpoch ||
        expected.digest !== this.candidate.manifest.stateDigest)
    )
      return;
    const loader = this.candidateLoader;
    const digest = this.candidate.manifest.stateDigest;
    this.cancelTransition();
    this.candidate = null;
    this.candidateEpoch = null;
    this.candidateLoader = null;
    this.candidateSelection = EMPTY_SELECTION;
    this.coverageReadyFrame = null;
    this.commitAfterFrame = null;
    this.candidateOpacity = 0;
    this.updateLayers();
    loader.close();
    this.removeReadyDigest(digest);
    loader.purge();
    this.callbacks.onTransition("idle");
  }
  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.inspectTimer);
    clearTimeout(this.cameraTimer);
    this.cancelTransition();
    this.cancelPrefetch();
    this.resize.disconnect();
    this.tabIndexObserver.disconnect();
    for (const remove of this.listeners) remove();
    this.deck?.finalize();
    this.deck = null;
    this.displayedLoader.unpin(inspectionTiles(this.displayedSelection.tiles));
    this.displayedLoader.close();
    this.candidateLoader?.close();
    this.resources.pool.close();
    this.resources.cache.clear();
  }
  private layers(): LifeTileLayer<TileData>[] {
    const layers = [
      this.layer(
        this.displayed,
        this.displayedLoader,
        "displayed",
        this.initialOpacity,
      ),
    ];
    if (this.candidate && this.candidateLoader)
      layers.push(
        this.layer(
          this.candidate,
          this.candidateLoader,
          "candidate",
          this.candidateOpacity,
        ),
      );
    return layers;
  }
  private layer(
    snapshot: ImmutableSnapshot,
    loader: TileLoader,
    role: "displayed" | "candidate",
    opacity: number,
  ): LifeTileLayer<TileData> {
    const digest = snapshot.manifest.stateDigest;
    return new LifeTileLayer<TileData>({
      id: `life-${digest}`,
      data: snapshot.manifestUrl.href,
      opacity,
      TilesetClass: LifeTileset,
      extent: [0, 0, WORLD_SIZE, WORLD_SIZE],
      tileSize: 16_384,
      minZoom: 0,
      maxZoom: 6,
      zoomOffset: 6,
      maxRequests: 7,
      maxCacheByteSize: DECK_LAYER_CACHE_BUDGET,
      onSelection: (level, visible) =>
        this.selectionChanged(level, visible, loader, role),
      getTileData: ({ index, signal }) =>
        loader.load(index, signal).then((data) => {
          if (data.availability === "missing")
            this.callbacks.onError("Tile unavailable; showing diagonal hatch");
          queueMicrotask(() => {
            if (role === "candidate") this.evaluateCoverage();
            else {
              this.evaluateInitialCoverage();
              if (this.pointerClientPosition) this.refreshInspection(false);
            }
          });
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
            transitionOpacity: props.opacity ?? 1,
            onResourceError: (message) => this.callbacks.onError(message),
            pickable: false,
          });
        const resourceKey = `${digest}:${tileId(props.data.index)}`;
        return new LifeTileTextureLayer(props, {
          id: `${props.id}-texture`,
          bounds,
          content: props.data,
          gpuBudget: this.gpu,
          transitionOpacity: props.opacity ?? 1,
          resourceKey,
          onResourceReady: (key) => this.resourceReady(key),
          onResourceReleased: (key) => this.resourceReleased(key),
          onResourceError: (message) => this.callbacks.onError(message),
          pickable: false,
        });
      },
    });
  }
  private updateLayers(): void {
    this.deck?.setProps({ layers: this.layers() });
  }
  private setCamera(camera: Camera): void {
    const next = clampCamera(
      camera,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
    );
    const changed = !sameCamera(this.camera, next);
    if (changed) this.resetInitialCoverage();
    this.camera = next;
    this.deck?.setProps({
      viewState: {
        target: [this.camera.x, this.camera.y, 0],
        zoom: this.camera.zoom,
      },
    });
    if (changed) this.refreshInspection();
    this.publishCamera();
  }
  private viewChanged({
    viewState,
    interactionState,
  }: ViewStateChangeParameters) {
    const previous = this.camera;
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
    if (!sameCamera(previous, this.camera)) this.resetInitialCoverage();
    if (!sameCamera(previous, this.camera)) this.refreshInspection();
    if (Object.values(interactionState).some(Boolean)) this.publishCamera();
    this.evaluateCoverage();
    this.evaluateInitialCoverage();
  }
  private publishCamera(): void {
    clearTimeout(this.cameraTimer);
    this.cameraTimer = window.setTimeout(() => {
      this.callbacks.onCamera(this.camera);
      history.replaceState(null, "", serializeCamera(this.camera));
    }, 120);
  }
  private pointer(event: PointerEvent): void {
    this.pointerClientPosition = [event.clientX, event.clientY];
    this.refreshInspection(false);
  }
  private refreshInspection(clear = true): void {
    clearTimeout(this.inspectTimer);
    if (clear) this.callbacks.onInspect(null, false, null);
    if (!this.pointerClientPosition) return;
    this.inspectTimer = window.setTimeout(() => {
      if (this.pointerClientPosition) {
        const rect = this.canvas.getBoundingClientRect();
        this.inspectScreen(
          this.pointerClientPosition[0] - rect.left,
          this.pointerClientPosition[1] - rect.top,
          false,
        );
      }
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
        true,
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
    const next = clampCamera(
      this.camera,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
    );
    const changed = !sameCamera(this.camera, next);
    this.camera = next;
    this.deck?.setProps({
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      viewState: {
        target: [this.camera.x, this.camera.y, 0],
        zoom: this.camera.zoom,
      },
    });
    if (changed) {
      this.callbacks.onCamera(this.camera);
      this.refreshInspection();
      this.publishCamera();
    } else if (this.pointerClientPosition) this.refreshInspection();
  }
  private contextLost(event: Event): void {
    event.preventDefault();
    this.callbacks.onContext(true);
    this.cancelPrefetch();
    this.cancelTransition();
    this.renderReady.clear();
    this.coverageReadyFrame = null;
    this.commitAfterFrame = null;
    this.initialCoverageReadyFrame = null;
    this.initialCommitAfterFrame = null;
    if (this.initialIdentity) this.initialOpacity = 0;
    if (this.candidate) {
      this.candidateOpacity = 0;
      this.callbacks.onTransition("staging");
    }
    if (this.initialIdentity) this.callbacks.onTransition("staging");
    const deck = this.deck;
    this.deck = null;
    deck?.finalize();
  }
  private contextRestored(): void {
    if (this.destroyed) return;
    try {
      this.createDeck();
      this.callbacks.onContext(false);
      this.evaluateCoverage();
      this.evaluateInitialCoverage();
    } catch (cause) {
      this.callbacks.onError(
        cause instanceof Error ? cause.message : "Renderer restoration failed",
      );
    }
  }
  private selectionChanged(
    level: number,
    visible: readonly TileIndex[],
    loader: TileLoader,
    role: "displayed" | "candidate",
  ): void {
    const selection = createSelection(level, visible);
    if (role === "candidate") {
      if (selection.key === this.candidateSelection.key) return;
      this.candidateSelection = selection;
      this.coverageReadyFrame = null;
      if (
        this.candidateOpacity > 0 ||
        this.transitionFrame ||
        this.commitAfterFrame
      )
        this.returnToStaging();
      this.evaluateCoverage();
      return;
    }
    if (selection.key === this.displayedSelection.key) return;
    loader.unpin(inspectionTiles(this.displayedSelection.tiles));
    this.displayedSelection = selection;
    this.callbacks.onLevel(level);
    loader.pin(inspectionTiles(visible));
    if (this.pointerClientPosition) this.refreshInspection(false);
    this.cancelPrefetch();
    this.schedulePrefetch(loader, visible);
    this.evaluateInitialCoverage();
  }
  private schedulePrefetch(
    loader: TileLoader,
    visible: readonly TileIndex[],
  ): void {
    const visibleIds = new Set(visible.map(tileId));
    const candidates = ring(visible).filter(
      (index) => !visibleIds.has(tileId(index)),
    );
    if (!candidates.length) return;
    const controller = new AbortController();
    this.prefetchController = controller;
    this.idleCallback = requestIdle(() => {
      this.idleCallback = 0;
      void loader
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
    return `${this.displayed.manifest.stateDigest}:${tileId(index)}`;
  }
  private inspectScreen(
    screenX: number,
    screenY: number,
    announce: boolean,
  ): void {
    if (this.initialIdentity)
      return this.callbacks.onInspect(null, false, null);
    const viewport = this.deck?.getViewports()[0];
    if (!(viewport instanceof OrthographicViewport)) return;
    const world = viewport.unproject([screenX, screenY]);
    const x = Math.floor(world[0]!);
    const y = Math.floor(world[1]!);
    if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE)
      return this.callbacks.onInspect(null, false, null);
    const mapped = worldToTile(x, y, this.displayedSelection.level);
    let data = this.displayedLoader.cache.get(this.cacheKey(mapped.tile));
    if (!data) {
      const parent = parentIndex(mapped.tile);
      if (parent) data = this.displayedLoader.cache.get(this.cacheKey(parent));
    }
    const inspection =
      data?.availability === "loaded"
        ? inspect(
            data.tile,
            x,
            y,
            data.index.z,
            this.displayed.manifest.generation,
          )
        : null;
    this.callbacks.onInspect(
      inspection,
      announce,
      inspection?.kind === "cell"
        ? projectCell(viewport, inspection.x, inspection.y)
        : null,
    );
  }

  private evaluateCoverage(): void {
    if (!this.candidate || !this.candidateLoader || !this.deck) return;
    const digest = this.candidate.manifest.stateDigest;
    const covered = hasRequiredCoverage(
      this.candidateSelection.tiles,
      digest,
      (key) => this.renderReady.has(key),
    );
    if (!covered) {
      this.coverageReadyFrame = null;
      if (
        this.candidateOpacity > 0 ||
        this.transitionFrame ||
        this.commitAfterFrame
      )
        this.returnToStaging();
      return;
    }
    if (this.coverageReadyFrame === null) {
      this.coverageReadyFrame = this.renderFrame;
      return;
    }
    if (
      this.renderFrame > this.coverageReadyFrame &&
      !this.transitionFrame &&
      this.commitAfterFrame === null &&
      this.candidateOpacity === 0
    )
      this.beginTransition();
  }

  private beginTransition(): void {
    if (!this.candidate || !this.candidateLoader) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.callbacks.onTransition("crossfading");
    if (reduced) {
      this.candidateOpacity = 1;
      this.updateLayers();
      this.commitAfterFrame = this.renderFrame;
      return;
    }
    this.transitionStarted = performance.now();
    const animate = (now: number) => {
      const progress = Math.min(1, (now - this.transitionStarted) / 240);
      this.candidateOpacity = progress;
      this.updateLayers();
      if (progress < 1) this.transitionFrame = requestAnimationFrame(animate);
      else {
        this.transitionFrame = 0;
        this.commitAfterFrame = this.renderFrame;
      }
    };
    this.transitionFrame = requestAnimationFrame(animate);
  }

  private commitCandidate(): void {
    if (
      !this.candidate ||
      !this.candidateLoader ||
      this.candidateEpoch === null ||
      !hasRequiredCoverage(
        this.candidateSelection.tiles,
        this.candidate.manifest.stateDigest,
        (key) => this.renderReady.has(key),
      )
    ) {
      this.returnToStaging();
      return;
    }
    const previousLoader = this.displayedLoader;
    const previousDigest = this.displayed.manifest.stateDigest;
    const identity = {
      epoch: this.candidateEpoch,
      digest: this.candidate.manifest.stateDigest,
    };
    if (!this.callbacks.approveSnapshotCommit(this.candidate, identity)) {
      this.returnToStaging();
      return;
    }
    previousLoader.unpin(inspectionTiles(this.displayedSelection.tiles));
    this.displayed = this.candidate;
    this.displayedLoader = this.candidateLoader;
    this.displayedSelection = this.candidateSelection;
    this.callbacks.onLevel(this.displayedSelection.level);
    this.displayedLoader.pin(inspectionTiles(this.displayedSelection.tiles));
    this.candidate = null;
    this.candidateEpoch = null;
    this.candidateLoader = null;
    this.candidateSelection = EMPTY_SELECTION;
    this.coverageReadyFrame = null;
    this.commitAfterFrame = null;
    this.candidateOpacity = 0;
    this.updateLayers();
    previousLoader.close();
    this.removeReadyDigest(previousDigest);
    previousLoader.purge();
    this.cancelPrefetch();
    this.schedulePrefetch(this.displayedLoader, this.displayedSelection.tiles);
    this.refreshInspection();
    this.callbacks.onTransition("idle");
  }

  private evaluateInitialCoverage(): void {
    if (!this.initialIdentity || !this.deck) return;
    const covered = hasRequiredCoverage(
      this.displayedSelection.tiles,
      this.initialIdentity.digest,
      (key) => this.renderReady.has(key),
    );
    if (!covered) {
      this.initialCoverageReadyFrame = null;
      this.initialCommitAfterFrame = null;
      if (this.initialOpacity !== 0) {
        this.initialOpacity = 0;
        this.updateLayers();
      }
      return;
    }
    if (this.initialCoverageReadyFrame === null) {
      this.initialCoverageReadyFrame = this.renderFrame;
      return;
    }
    if (
      this.renderFrame > this.initialCoverageReadyFrame &&
      this.initialOpacity === 0 &&
      this.initialCommitAfterFrame === null
    ) {
      this.initialOpacity = 1;
      this.updateLayers();
      this.initialCommitAfterFrame = this.renderFrame;
    }
  }

  private resetInitialCoverage(): void {
    if (!this.initialIdentity) return;
    this.initialCoverageReadyFrame = null;
    this.initialCommitAfterFrame = null;
    if (this.initialOpacity !== 0) {
      this.initialOpacity = 0;
      this.updateLayers();
    }
    this.callbacks.onTransition("staging");
  }

  private commitInitial(): void {
    const identity = this.initialIdentity;
    if (
      !identity ||
      !hasRequiredCoverage(
        this.displayedSelection.tiles,
        identity.digest,
        (key) => this.renderReady.has(key),
      ) ||
      !this.callbacks.approveSnapshotCommit(this.displayed, identity)
    ) {
      this.initialOpacity = 0;
      this.initialCommitAfterFrame = null;
      this.updateLayers();
      return;
    }
    this.initialIdentity = null;
    this.initialCoverageReadyFrame = null;
    this.initialCommitAfterFrame = null;
    this.refreshInspection();
    this.callbacks.onTransition("idle");
  }

  private cancelTransition(): void {
    if (this.transitionFrame) cancelAnimationFrame(this.transitionFrame);
    this.transitionFrame = 0;
    this.commitAfterFrame = null;
  }
  private returnToStaging(): void {
    this.cancelTransition();
    this.candidateOpacity = 0;
    this.updateLayers();
    if (this.candidate) this.callbacks.onTransition("staging");
  }
  private resourceReady(key: string): void {
    this.renderReady.set(key, (this.renderReady.get(key) ?? 0) + 1);
    this.evaluateCoverage();
    this.evaluateInitialCoverage();
  }
  private resourceReleased(key: string): void {
    const owners = this.renderReady.get(key) ?? 0;
    if (owners <= 1) this.renderReady.delete(key);
    else this.renderReady.set(key, owners - 1);
    this.evaluateCoverage();
    this.evaluateInitialCoverage();
  }
  private removeReadyDigest(digest: string): void {
    for (const key of this.renderReady.keys())
      if (key.startsWith(`${digest}:`)) this.renderReady.delete(key);
  }
  private afterRender(): void {
    if (this.canvas.tabIndex !== -1) this.canvas.tabIndex = -1;
    this.renderFrame += 1;
    this.evaluateCoverage();
    this.evaluateInitialCoverage();
    if (
      this.commitAfterFrame !== null &&
      this.renderFrame > this.commitAfterFrame
    )
      this.commitCandidate();
    if (
      this.initialCommitAfterFrame !== null &&
      this.renderFrame > this.initialCommitAfterFrame
    )
      this.commitInitial();
  }
}

function createSelection(
  level: number,
  tiles: readonly TileIndex[],
): Selection {
  return {
    level,
    tiles: [...tiles],
    key: `${level}:${tiles.map(tileId).sort().join(",")}`,
  };
}

function sameCamera(left: Camera, right: Camera): boolean {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

function projectCell(
  viewport: OrthographicViewport,
  x: number,
  y: number,
): CellHighlight {
  const first = viewport.project([x, y, 0]);
  const second = viewport.project([x + 1, y + 1, 0]);
  const left = Math.min(first[0]!, second[0]!);
  const top = Math.min(first[1]!, second[1]!);
  return {
    left,
    top,
    width: Math.abs(second[0]! - first[0]!),
    height: Math.abs(second[1]! - first[1]!),
  };
}

function inspectionTiles(tiles: readonly TileIndex[]): TileIndex[] {
  return [
    ...new Map(
      tiles
        .flatMap((index) => [index, parentIndex(index)])
        .filter((index): index is TileIndex => index !== null)
        .map((index) => [tileId(index), index]),
    ).values(),
  ];
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
