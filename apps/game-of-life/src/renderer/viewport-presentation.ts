import { MAX_ZOOM } from "@/indexer/schema";
import type { Camera } from "./camera";

export interface ScaleRuler {
  readonly cells: number;
  readonly pixels: number;
  readonly label: string;
}

export function renderingMode(level: number, zoom: number): string {
  if (level < MAX_ZOOM) {
    const side = 2 ** (MAX_ZOOM - level);
    return `Density · ${side} × ${side} cells per sample`;
  }
  const pixelsPerCell = 2 ** zoom;
  const formatted = Number.isInteger(pixelsPerCell)
    ? pixelsPerCell.toLocaleString()
    : pixelsPerCell.toFixed(1);
  return `Exact cells · ${formatted} px per cell`;
}

export function scaleRuler(zoom: number, targetPixels = 80): ScaleRuler {
  const scale = 2 ** zoom;
  const targetCells = targetPixels / scale;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, targetCells)));
  const normalized = targetCells / magnitude;
  const factor = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  const cells = Math.max(1, factor * magnitude);
  return {
    cells,
    pixels: cells * scale,
    label: `${cells.toLocaleString()} ${cells === 1 ? "cell" : "cells"}`,
  };
}

export function cellScreenRect(
  camera: Camera,
  viewport: { readonly width: number; readonly height: number },
  x: number,
  y: number,
) {
  const scale = 2 ** camera.zoom;
  return {
    left: viewport.width / 2 + (x - camera.x) * scale,
    top: viewport.height / 2 + (y - camera.y) * scale,
    size: scale,
  };
}
