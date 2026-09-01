import type { Viewport } from "@deck.gl/core";
import {
  _Tileset2D as Tileset2D,
  type _Tileset2DProps as Tileset2DProps,
  TileLayer,
} from "@deck.gl/geo-layers";
import {
  parentIndex,
  selectPyramidLevel,
  tileId,
  type TileIndex,
} from "./pyramid";

interface LifeTilesetProps extends Tileset2DProps {
  readonly onSelection?: (level: number, visible: readonly TileIndex[]) => void;
}

interface LifeTileLayerProps {
  readonly onSelection: (level: number, visible: readonly TileIndex[]) => void;
}

export class LifeTileLayer<DataT> extends TileLayer<DataT, LifeTileLayerProps> {
  override _getTilesetOptions(): Tileset2DProps {
    return {
      ...super._getTilesetOptions(),
      onSelection: this.props.onSelection,
    } as LifeTilesetProps;
  }
}

interface Parameters {
  viewport: Viewport;
  minZoom?: number;
  maxZoom?: number;
  zRange: [number, number] | null;
  modelMatrix?: never;
  modelMatrixInverse?: never;
}

// Isolate the only use of deck.gl's private scheduler API for straightforward upgrades.
export class LifeTileset extends Tileset2D {
  private level: number | null = null;
  constructor(options: LifeTilesetProps) {
    super(options);
  }
  override getTileIndices(parameters: Parameters): TileIndex[] {
    this.level = selectPyramidLevel(
      this.level,
      parameters.viewport.zoom + this.opts.zoomOffset,
    );
    const visible = super.getTileIndices({
      ...parameters,
      minZoom: this.level,
      maxZoom: this.level,
    }) as TileIndex[];
    (this.opts as LifeTilesetProps).onSelection?.(this.level, visible);
    const parents = visible
      .map(parentIndex)
      .filter((index): index is TileIndex => index !== null);
    return [
      ...new Map(
        [...visible, ...parents].map((index) => [tileId(index), index]),
      ).values(),
    ];
  }
}
