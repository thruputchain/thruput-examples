import { parentIndex, tileId, type TileIndex } from "./pyramid";

export function hasRequiredCoverage(
  visible: readonly TileIndex[],
  digest: string,
  isReady: (key: string) => boolean,
): boolean {
  return (
    visible.length > 0 &&
    visible.every((index) => {
      if (isReady(`${digest}:${tileId(index)}`)) return true;
      if (index.z === 6) return false;
      const parent = parentIndex(index);
      return Boolean(parent && isReady(`${digest}:${tileId(parent)}`));
    })
  );
}
