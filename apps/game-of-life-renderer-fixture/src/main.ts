import { Deck, OrthographicView, OrthographicViewport } from "@deck.gl/core";
import {
  TileLayer,
  type _TileLoadProps as TileLoadProps,
  type _Tile2DHeader as Tile2DHeader,
  type NonGeoBoundingBox,
} from "@deck.gl/geo-layers";
import { LifeTextureLayer, type LifeTextureData } from "./life-texture-layer";
import { PolygonLayer } from "@deck.gl/layers";
import { HystereticLifeTileset } from "./life-tileset";
import {
  applyStrictImmediateParentRefinement,
  hasCompleteSelectedCoverage,
} from "./model";

interface FixtureTileData extends LifeTextureData {
  index: { x: number; y: number; z: number };
}

interface PickingTileData {
  bounds: NonGeoBoundingBox;
  content: FixtureTileData;
}

interface Metrics {
  aborted: number;
  errors: string[];
  finalized: number;
  resourcesCreated: number;
  resourcesDestroyed: number;
  refinementCalls: number;
  requested: string[];
  loadedDigests: string[];
  loadedZooms: number[];
  tileUnloads: number;
}

const metrics: Metrics = {
  aborted: 0,
  errors: [],
  finalized: 0,
  resourcesCreated: 0,
  resourcesDestroyed: 0,
  refinementCalls: 0,
  requested: [],
  loadedDigests: [],
  loadedZooms: [],
  tileUnloads: 0,
};
let controllerDeck: Deck<OrthographicView> | null = null;

function createTileLayer(
  digest: string,
  delayMs: number,
  maxCacheByteSize = 8 * 1024 * 1024,
  requireCompleteCoverage = false,
): TileLayer<FixtureTileData> {
  return new TileLayer<FixtureTileData>({
    id: `life-${digest}`,
    data: `fixture://${digest}/{z}/{x}/{y}`,
    TilesetClass: HystereticLifeTileset,
    extent: [0, 0, 10_000, 10_000],
    tileSize: 16_384,
    minZoom: 0,
    maxZoom: 6,
    zoomOffset: 6,
    maxRequests: 2,
    maxCacheByteSize,
    getTileData: (load) => loadTile(digest, delayMs, load),
    refinementStrategy: (tiles) => {
      metrics.refinementCalls += 1;
      const typedTiles = tiles as Array<
        Tile2DHeader<FixtureTileData> & {
          content: FixtureTileData | null;
        }
      >;
      applyStrictImmediateParentRefinement(typedTiles, digest);
      if (
        requireCompleteCoverage &&
        !hasCompleteSelectedCoverage(typedTiles, digest)
      ) {
        for (const tile of typedTiles) {
          tile.isVisible = false;
        }
      }
    },
    onTileLoad: (tile) => {
      if (tile.content) {
        metrics.loadedDigests.push(tile.content.digest);
        metrics.loadedZooms.push(tile.content.index.z);
      }
    },
    onTileUnload: () => {
      metrics.tileUnloads += 1;
    },
    renderSubLayers: (props) => {
      const rawBounds = props.tile.bbox as NonGeoBoundingBox;
      const bounds: NonGeoBoundingBox = {
        left: Math.max(rawBounds.left, 0),
        top: Math.max(rawBounds.top, 0),
        right: Math.min(rawBounds.right, 10_000),
        bottom: Math.min(rawBounds.bottom, 10_000),
      };
      const lifeLayer = new LifeTextureLayer(props, {
        id: `${props.id}-${digest}`,
        pickable: false,
        bounds: [bounds.left, bounds.top, bounds.right, bounds.bottom],
        content: props.data,
        onResourceCreated: () => {
          metrics.resourcesCreated += 1;
        },
        onResourceDestroyed: () => {
          metrics.resourcesDestroyed += 1;
        },
        onFinalize: () => {
          metrics.finalized += 1;
        },
      });
      const { data: _tileSource, ...subLayerProps } = props;
      const pickLayer = new PolygonLayer<PickingTileData>({
        ...subLayerProps,
        id: `${props.id}-${digest}-picking`,
        data: [{ bounds, content: props.data }],
        pickable: true,
        filled: true,
        stroked: false,
        getFillColor: [0, 0, 0, 0],
        getPolygon: ({ bounds: pickBounds }) => [
          [pickBounds.left, pickBounds.top],
          [pickBounds.right, pickBounds.top],
          [pickBounds.right, pickBounds.bottom],
          [pickBounds.left, pickBounds.bottom],
        ],
      });
      return [lifeLayer, pickLayer];
    },
  });
}

async function loadTile(
  digest: string,
  delayMs: number,
  { index, signal }: TileLoadProps,
): Promise<FixtureTileData> {
  metrics.requested.push(`${digest}:${index.z}/${index.x}/${index.y}`);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      const content = createContent(digest, index);
      resolve({
        index,
        ...content,
      });
    }, delayMs);
    const abort = (): void => {
      window.clearTimeout(timer);
      metrics.aborted += 1;
      reject(new DOMException("Tile load aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function createContent(
  digest: string,
  index: { x: number; y: number; z: number },
): LifeTextureData {
  const cellsPerTexel = 2 ** (6 - index.z);
  const tileOrigin: [number, number] = [
    index.x * 256 * cellsPerTexel,
    index.y * 256 * cellsPerTexel,
  ];
  if (index.z === 6) {
    const packed = new Uint8Array(8_192);
    for (let position = 0; position < packed.length; position += 1) {
      const value = position % 2 === 0 ? 0x55 : 0xaa;
      packed[position] = digest === "new" ? value : value ^ 0xff;
    }
    const values = new Uint8Array(256 * 256);
    for (let y = 0; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1) {
        values[y * 256 + x] =
          (packed[y * 32 + Math.floor(x / 8)]! >> (x % 8)) & 1;
      }
    }
    return {
      byteLength: packed.byteLength + values.byteLength,
      cellsPerTexel,
      digest,
      tile: { kind: "cells", packed, values },
      tileOrigin,
    };
  }

  const values = new Uint16Array(256 * 256);
  for (let position = 0; position < values.length; position += 1) {
    const texelX = position % 256;
    const texelY = Math.floor(position / 256);
    const coveredX = Math.max(
      Math.min(
        10_000 - (tileOrigin[0] + texelX * cellsPerTexel),
        cellsPerTexel,
      ),
      0,
    );
    const coveredY = Math.max(
      Math.min(
        10_000 - (tileOrigin[1] + texelY * cellsPerTexel),
        cellsPerTexel,
      ),
      0,
    );
    const coveredCells = coveredX * coveredY;
    const base = position % (coveredCells + 1);
    values[position] = digest === "new" ? base : coveredCells - base;
  }
  return {
    byteLength: values.byteLength,
    cellsPerTexel,
    digest,
    tile: { kind: "density", values },
    tileOrigin,
  };
}

async function runDeckLifecycleProbe(): Promise<{
  aborted: number;
  errors: string[];
  evictionResourceDestructions: number;
  finalized: number;
  loadedDigests: string[];
  pickedDigest: string | null;
  pickedCoveredCells: number | null;
  pickedLayerId: string | null;
  pickedValue: number | null;
  pickedTexel: number[] | null;
  refinementCalls: number;
  renderedPixel: number[];
  requested: string[];
  resourcesCreated: number;
  resourcesDestroyed: number;
  tileUnloads: number;
  outsideWorldPicked: boolean;
}> {
  resetMetrics();
  const canvas = document.querySelector<HTMLCanvasElement>("#fixture");
  if (!canvas) {
    throw new Error("fixture canvas is missing");
  }

  const deck = new Deck({
    canvas,
    width: 512,
    height: 512,
    views: new OrthographicView({ id: "life", flipY: true, controller: false }),
    initialViewState: { target: [5_000, 5_000, 0], zoom: -6 },
    layers: [
      createTileLayer("old", 5),
      createTileLayer("new", 5, undefined, true),
    ],
    onError: (error) => {
      metrics.errors.push(error.message);
    },
  });
  await waitFor(() => new Set(metrics.loadedDigests).size === 2);
  await waitFor(() => metrics.resourcesCreated >= 4);
  const initialLoadedDigests = [...new Set(metrics.loadedDigests)].sort();
  deck.redraw("fixture-ready");
  await nextFrame();
  await nextFrame();

  const picked = pickWorldSample(deck, canvas, [5_000, 5_000]);
  const outsideWorldPicked =
    pickWorldSample(deck, canvas, [10_032, 10_032]).data !== null;

  deck.setProps({
    viewState: { target: [256, 256, 0], zoom: 0 },
    layers: [createTileLayer("eviction", 5, 150_000)],
  });
  await waitFor(() =>
    metrics.requested.some((request) => request.startsWith("eviction:6/")),
  );
  await waitFor(() => metrics.loadedDigests.includes("eviction"));
  const unloadsBeforeMove = metrics.tileUnloads;
  const destroyedBeforeMove = metrics.resourcesDestroyed;
  deck.setProps({
    viewState: { target: [9_744, 9_744, 0], zoom: 0 },
    layers: [createTileLayer("eviction", 5, 150_000)],
  });
  await waitFor(() =>
    metrics.requested.some((request) => request === "eviction:6/39/39"),
  );
  await waitFor(() => metrics.tileUnloads > unloadsBeforeMove);
  await waitFor(() => metrics.resourcesDestroyed > destroyedBeforeMove);
  const evictionResourceDestructions =
    metrics.resourcesDestroyed - destroyedBeforeMove;

  deck.setProps({
    viewState: { target: [5_000, 5_000, 0], zoom: -6 },
    layers: [createTileLayer("delayed", 10_000)],
  });
  await waitFor(() =>
    metrics.requested.some((request) => request.startsWith("delayed:")),
  );
  deck.finalize();
  await new Promise((resolve) => window.setTimeout(resolve, 20));

  return {
    aborted: metrics.aborted,
    errors: [...metrics.errors],
    evictionResourceDestructions,
    finalized: metrics.finalized,
    loadedDigests: initialLoadedDigests,
    pickedDigest: picked.data?.content.digest ?? null,
    pickedCoveredCells: picked.coveredCells,
    pickedLayerId: picked.layerId,
    pickedValue: picked.value,
    pickedTexel: picked.texel,
    refinementCalls: metrics.refinementCalls,
    renderedPixel: picked.pixel,
    requested: [...metrics.requested],
    resourcesCreated: metrics.resourcesCreated,
    resourcesDestroyed: metrics.resourcesDestroyed,
    tileUnloads: metrics.tileUnloads,
    outsideWorldPicked,
  };
}

async function runClippedEdgeProbe(): Promise<{
  coveredCells: number;
  errors: string[];
  insidePixel: number[];
  outsidePixel: number[];
  value: number;
}> {
  resetMetrics();
  const canvas = document.querySelector<HTMLCanvasElement>("#fixture");
  if (!canvas) {
    throw new Error("fixture canvas is missing");
  }
  const content = createContent("new", { x: 0, y: 0, z: 0 });
  const deck = new Deck({
    canvas,
    width: 512,
    height: 512,
    views: new OrthographicView({ id: "edge", flipY: true, controller: false }),
    initialViewState: { target: [9_760, 9_760, 0], zoom: 0 },
    layers: [
      new LifeTextureLayer({
        id: "clipped-edge",
        bounds: [0, 0, 10_000, 10_000],
        content,
        onResourceCreated: () => {
          metrics.resourcesCreated += 1;
        },
        onResourceDestroyed: () => {
          metrics.resourcesDestroyed += 1;
        },
        onFinalize: () => {
          metrics.finalized += 1;
        },
      }),
    ],
    onError: (error) => {
      metrics.errors.push(error.message);
    },
  });
  await waitFor(() => metrics.resourcesCreated === 2);
  deck.redraw("clipped-edge-ready");
  await nextFrame();
  await nextFrame();

  const texel = 156;
  const coveredCells = coveredCellCount(content, texel, texel);
  const value = content.tile.values[texel * 256 + texel]!;
  const insidePixel = readWorldPixel(deck, canvas, [9_992, 9_992]);
  const outsidePixel = readWorldPixel(deck, canvas, [10_008, 10_008]);
  deck.finalize();
  return {
    coveredCells,
    errors: [...metrics.errors],
    insidePixel,
    outsidePixel,
    value,
  };
}

async function runExactCellProbe(): Promise<{
  byteLength: number;
  decodedByteLength: number;
  errors: string[];
  packedByteLength: number;
  pixels: number[][];
  resourcesCreated: number;
  resourcesDestroyed: number;
  values: Array<number | null>;
  zooms: Array<number | null>;
}> {
  resetMetrics();
  const canvas = document.querySelector<HTMLCanvasElement>("#fixture");
  if (!canvas) {
    throw new Error("fixture canvas is missing");
  }
  const deck = new Deck({
    canvas,
    width: 512,
    height: 512,
    views: new OrthographicView({
      id: "exact",
      flipY: true,
      controller: false,
    }),
    initialViewState: { target: [384, 384, 0], zoom: 2 },
    layers: [createTileLayer("new", 5)],
    onError: (error) => {
      metrics.errors.push(error.message);
    },
  });
  await waitFor(() => metrics.loadedZooms.includes(6));
  await waitFor(() => metrics.resourcesCreated >= 2);
  deck.redraw("exact-cells-ready");
  await nextFrame();
  await nextFrame();

  const samples = [
    pickWorldSample(deck, canvas, [384.25, 384.25]),
    pickWorldSample(deck, canvas, [385.25, 384.25]),
  ];
  const content = samples[0]?.data?.content;
  if (!content || content.tile.kind !== "cells") {
    deck.finalize();
    throw new Error("zoom-six exact-cell tile was not picked");
  }
  const result = {
    byteLength: content.byteLength,
    decodedByteLength: content.tile.values.byteLength,
    errors: [...metrics.errors],
    packedByteLength: content.tile.packed.byteLength,
    pixels: samples.map(({ pixel }) => pixel),
    resourcesCreated: metrics.resourcesCreated,
    resourcesDestroyed: 0,
    values: samples.map(({ value }) => value),
    zooms: samples.map(({ data }) => data?.content.index.z ?? null),
  };
  deck.finalize();
  result.resourcesDestroyed = metrics.resourcesDestroyed;
  return result;
}

function setupControllerProbe(): void {
  controllerDeck?.finalize();
  const canvas = document.querySelector<HTMLCanvasElement>("#fixture");
  if (!canvas) {
    throw new Error("fixture canvas is missing");
  }
  controllerDeck = new Deck({
    canvas,
    width: 512,
    height: 512,
    views: new OrthographicView({
      id: "life",
      flipY: true,
      controller: {
        dragRotate: false,
        touchRotate: false,
        maxBounds: [
          [0, 0],
          [10_000, 10_000],
        ],
      },
    }),
    initialViewState: { target: [5_000, 5_000, 0], zoom: 0 },
    layers: [],
  });
}

function getControllerTarget(): number[] {
  const viewport = controllerDeck?.getViewports()[0];
  if (!(viewport instanceof OrthographicViewport)) {
    throw new Error("controller probe is not running");
  }
  return [...viewport.target];
}

function finalizeControllerProbe(): void {
  controllerDeck?.finalize();
  controllerDeck = null;
}

function runIntegerTextureProbe(): {
  error: number;
  pixels: number[];
  renderer: string;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 1;
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) {
    throw new Error("WebGL2 is unavailable");
  }

  const vertex = compileShader(
    gl,
    gl.VERTEX_SHADER,
    `#version 300 es
    const vec2 positions[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    void main() { gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0); }`,
  );
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    `#version 300 es
    precision highp float;
    precision highp usampler2D;
    uniform usampler2D values;
    out vec4 color;
    void main() {
      uint value = texelFetch(values, ivec2(int(gl_FragCoord.x), 0), 0).r;
      color = vec4(float(value & 255u) / 255.0, float((value >> 8u) & 255u) / 255.0, 0.0, 1.0);
    }`,
  );
  const program = gl.createProgram();
  const texture = gl.createTexture();
  const vertexArray = gl.createVertexArray();
  if (!program || !texture || !vertexArray) {
    throw new Error("WebGL resource allocation failed");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(
      gl.getProgramInfoLog(program) ?? "WebGL program link failed",
    );
  }

  gl.bindVertexArray(vertexArray);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R16UI,
    2,
    1,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_SHORT,
    new Uint16Array([513, 4_095]),
  );
  gl.viewport(0, 0, 2, 1);
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "values"), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const pixels = new Uint8Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const error = gl.getError();
  const renderer = String(gl.getParameter(gl.RENDERER));

  gl.deleteTexture(texture);
  gl.deleteProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  gl.deleteVertexArray(vertexArray);
  return { error, pixels: [...pixels], renderer };
}

function compileShader(
  gl: WebGL2RenderingContext,
  kind: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(kind);
  if (!shader) {
    throw new Error("WebGL shader allocation failed");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(
      gl.getShaderInfoLog(shader) ?? "WebGL shader compile failed",
    );
  }
  return shader;
}

function pickWorldSample(
  deck: Deck<OrthographicView>,
  canvas: HTMLCanvasElement,
  world: [number, number],
): {
  coveredCells: number | null;
  data: PickingTileData | null;
  layerId: string | null;
  pixel: number[];
  texel: number[] | null;
  value: number | null;
} {
  const viewport = deck.getViewports()[0];
  if (!viewport) {
    throw new Error("deck did not create a viewport");
  }
  const [x, y] = viewport.project([world[0], world[1], 0]);
  const pixel = readWorldPixel(deck, canvas, world);
  const picked = deck.pickObject({ x: x!, y: y!, radius: 0 });
  const data = (picked?.object as PickingTileData | undefined) ?? null;
  if (!data) {
    return {
      coveredCells: null,
      data: null,
      layerId: null,
      pixel,
      texel: null,
      value: null,
    };
  }
  const texel = [
    Math.floor(
      (world[0] - data.content.tileOrigin[0]) / data.content.cellsPerTexel,
    ),
    Math.floor(
      (world[1] - data.content.tileOrigin[1]) / data.content.cellsPerTexel,
    ),
  ];
  if (texel.some((coordinate) => coordinate < 0 || coordinate >= 256)) {
    throw new Error(
      "picked tile does not contain the requested world coordinate",
    );
  }
  return {
    coveredCells: coveredCellCount(data.content, texel[0]!, texel[1]!),
    data,
    layerId: picked?.layer?.id ?? null,
    pixel,
    texel,
    value: data.content.tile.values[texel[1]! * 256 + texel[0]!] ?? null,
  };
}

function readWorldPixel(
  deck: Deck<OrthographicView>,
  canvas: HTMLCanvasElement,
  world: [number, number],
): number[] {
  const viewport = deck.getViewports()[0];
  if (!viewport) {
    throw new Error("deck did not create a viewport");
  }
  const [x, y] = viewport.project([world[0], world[1], 0]);
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    throw new Error("deck WebGL2 context is unavailable");
  }
  const pixel = new Uint8Array(4);
  gl.readPixels(
    Math.floor(x!),
    canvas.height - Math.floor(y!) - 1,
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixel,
  );
  return [...pixel];
}

function coveredCellCount(
  content: LifeTextureData,
  texelX: number,
  texelY: number,
): number {
  const coveredX = Math.max(
    Math.min(
      10_000 - (content.tileOrigin[0] + texelX * content.cellsPerTexel),
      content.cellsPerTexel,
    ),
    0,
  );
  const coveredY = Math.max(
    Math.min(
      10_000 - (content.tileOrigin[1] + texelY * content.cellsPerTexel),
      content.cellsPerTexel,
    ),
    0,
  );
  return coveredX * coveredY;
}

function resetMetrics(): void {
  metrics.aborted = 0;
  metrics.errors = [];
  metrics.finalized = 0;
  metrics.resourcesCreated = 0;
  metrics.resourcesDestroyed = 0;
  metrics.refinementCalls = 0;
  metrics.requested = [];
  metrics.loadedDigests = [];
  metrics.loadedZooms = [];
  metrics.tileUnloads = 0;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("fixture condition timed out");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

declare global {
  interface Window {
    fixture: {
      finalizeControllerProbe: typeof finalizeControllerProbe;
      getControllerTarget: typeof getControllerTarget;
      runClippedEdgeProbe: typeof runClippedEdgeProbe;
      runDeckLifecycleProbe: typeof runDeckLifecycleProbe;
      runExactCellProbe: typeof runExactCellProbe;
      runIntegerTextureProbe: typeof runIntegerTextureProbe;
      setupControllerProbe: typeof setupControllerProbe;
    };
  }
}

window.fixture = {
  finalizeControllerProbe,
  getControllerTarget,
  runClippedEdgeProbe,
  runDeckLifecycleProbe,
  runExactCellProbe,
  runIntegerTextureProbe,
  setupControllerProbe,
};
