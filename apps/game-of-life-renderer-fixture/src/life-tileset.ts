import type { Viewport } from "@deck.gl/core";
import {
  _Tileset2D as Tileset2D,
  type _Tileset2DProps as Tileset2DProps,
} from "@deck.gl/geo-layers";
import { parentIndex, selectPyramidLevel, tileId } from "./model";

interface DeckTileIndex {
  x: number;
  y: number;
  z: number;
}

interface GetTileIndicesParameters {
  viewport: Viewport;
  maxZoom?: number;
  minZoom?: number;
  zRange: [number, number] | null;
  modelMatrix?: never;
  modelMatrixInverse?: never;
}

export class HystereticLifeTileset extends Tileset2D {
  private selectedLevel: number | null = null;

  constructor(options: Tileset2DProps) {
    super(options);
  }

  override getTileIndices(parameters: GetTileIndicesParameters): DeckTileIndex[] {
    const continuous = parameters.viewport.zoom + this.opts.zoomOffset;
    this.selectedLevel = selectPyramidLevel(this.selectedLevel, continuous);
    const selected = super.getTileIndices({
      ...parameters,
      minZoom: this.selectedLevel,
      maxZoom: this.selectedLevel,
    });
    if (this.selectedLevel === 0) {
      return selected;
    }

    const parents = selected
      .map(parentIndex)
      .filter((index): index is DeckTileIndex => index !== null);
    return [...new Map([...selected, ...parents].map((index) => [tileId(index), index])).values()];
  }
}
