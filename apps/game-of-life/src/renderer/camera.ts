import { WORLD_SIZE } from "@/indexer/schema";

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}
export const MIN_CAMERA_ZOOM = -6;
export const MAX_CAMERA_ZOOM = 0;
export function clampCamera(
  camera: Camera,
  width: number,
  height: number,
): Camera {
  const zoom = clamp(camera.zoom, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM);
  const scale = 2 ** zoom;
  const visibleWidth = width / scale;
  const visibleHeight = height / scale;
  return {
    x: clampAxis(camera.x, visibleWidth),
    y: clampAxis(camera.y, visibleHeight),
    zoom,
  };
}
export function fitCamera(width: number, height: number): Camera {
  return {
    x: WORLD_SIZE / 2,
    y: WORLD_SIZE / 2,
    zoom: clamp(
      Math.log2(Math.min(width, height) / WORLD_SIZE),
      MIN_CAMERA_ZOOM,
      MAX_CAMERA_ZOOM,
    ),
  };
}
export function zoomAround(
  camera: Camera,
  nextZoom: number,
  pointer: readonly [number, number],
  viewport: readonly [number, number],
): Camera {
  const zoom = clamp(nextZoom, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM);
  const oldScale = 2 ** camera.zoom;
  const newScale = 2 ** zoom;
  const worldX = camera.x + (pointer[0] - viewport[0] / 2) / oldScale;
  const worldY = camera.y + (pointer[1] - viewport[1] / 2) / oldScale;
  return {
    x: worldX - (pointer[0] - viewport[0] / 2) / newScale,
    y: worldY - (pointer[1] - viewport[1] / 2) / newScale,
    zoom,
  };
}
export function parseCamera(search: string): Camera | null {
  const query = new URLSearchParams(search);
  const keys = [...query.keys()];
  if (
    keys.length !== 3 ||
    !["x", "y", "z"].every((key) => query.getAll(key).length === 1) ||
    keys.some((key) => !["x", "y", "z"].includes(key))
  )
    return null;
  const values = [query.get("x"), query.get("y"), query.get("z")].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  const [x, y, zoom] = values as [number, number, number];
  if (
    x < 0 ||
    x > WORLD_SIZE ||
    y < 0 ||
    y > WORLD_SIZE ||
    zoom < MIN_CAMERA_ZOOM ||
    zoom > MAX_CAMERA_ZOOM
  )
    return null;
  return { x, y, zoom };
}
export function serializeCamera(camera: Camera): string {
  const query = new URLSearchParams({
    x: camera.x.toFixed(2),
    y: camera.y.toFixed(2),
    z: camera.zoom.toFixed(3),
  });
  return `?${query}`;
}
function clampAxis(value: number, visible: number): number {
  if (visible >= WORLD_SIZE) return WORLD_SIZE / 2;
  return clamp(value, visible / 2, WORLD_SIZE - visible / 2);
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
