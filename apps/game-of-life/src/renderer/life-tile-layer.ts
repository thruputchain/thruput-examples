import {
  Layer,
  picking,
  project32,
  type DefaultProps,
  type LayerProps,
  type UpdateParameters,
} from "@deck.gl/core";
import type { Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import { WORLD_SIZE } from "@/indexer/schema";
import type { ActiveByteBudget } from "./budget";
import type { LoadedTileData } from "./tile-loader";
import type { TileBounds } from "./pyramid";

interface Props extends LayerProps {
  bounds: TileBounds;
  content: LoadedTileData;
  gpuBudget: ActiveByteBudget;
  resourceKey: string;
  onResourceReady: (key: string) => void;
  onResourceReleased: (key: string) => void;
  onResourceError: (message: string) => void;
  transitionOpacity: number;
}
interface Resources {
  readonly model: Model;
  readonly texture: Texture;
  readonly release: () => void;
}
interface State {
  [key: string]: unknown;
  resources: Resources | undefined;
}
const defaultProps = {
  transitionOpacity: { type: "number", value: 1, min: 0, max: 1 },
} as DefaultProps<Props>;
const uniforms = {
  name: "life",
  fs: `uniform highp usampler2D integerTexture;
layout(std140) uniform lifeUniforms {
  vec2 tileOrigin;
  float cellsPerTexel;
  float exact;
  float layerOpacity;
} life;`,
  uniformTypes: {
    tileOrigin: "vec2<f32>",
    cellsPerTexel: "f32",
    exact: "f32",
    layerOpacity: "f32",
  },
};
const vertex = `#version 300 es
in vec3 positions; in vec2 texCoords; out vec2 lifeUv;
void main(void) { geometry.worldPosition = positions; geometry.uv = texCoords; geometry.pickingColor = vec3(1.,0.,0.); gl_Position = project_position_to_clipspace(positions, vec3(0.), vec3(0.), geometry.position); DECKGL_FILTER_GL_POSITION(gl_Position, geometry); lifeUv = texCoords; }`;
export const LIFE_FRAGMENT_SHADER = `#version 300 es
precision highp float; precision highp usampler2D; in vec2 lifeUv; out vec4 fragColor;
void main(void) { ivec2 texel = clamp(ivec2(floor(lifeUv * 256.)), ivec2(0), ivec2(255)); vec2 cellMin = life.tileOrigin + vec2(texel) * life.cellsPerTexel; vec2 covered = max(min(vec2(10000.) - cellMin, vec2(life.cellsPerTexel)), vec2(0.)); if (covered.x * covered.y <= 0.) discard; float value = float(texelFetch(integerTexture, texel, 0).r); float density = life.exact > .5 ? value : value / (covered.x * covered.y); vec3 dead = vec3(.025,.055,.051); vec3 live = vec3(.40,1.,.75); vec3 color = mix(dead, live, pow(density, .42)); if (life.exact > .5 && min(fract(lifeUv.x*256.), fract(lifeUv.y*256.)) < .035) color *= .55; float alpha = clamp(life.layerOpacity, 0., 1.); fragColor = vec4(color, alpha); DECKGL_FILTER_COLOR(fragColor, geometry); }`;

export class LifeTileTextureLayer extends Layer<Props> {
  declare state: State;
  static override layerName = "LifeTileTextureLayer";
  static override defaultProps = defaultProps;
  override getModels(): Model[] {
    const model = this.state?.resources?.model;
    return model ? [model] : [];
  }
  override getShaders() {
    return super.getShaders({
      vs: vertex,
      fs: LIFE_FRAGMENT_SHADER,
      modules: [project32, picking, uniforms],
    });
  }
  override initializeState(): void {
    this.createResources();
  }
  override updateState({ oldProps }: UpdateParameters<this>): void {
    if (
      oldProps.content !== this.props.content ||
      oldProps.gpuBudget !== this.props.gpuBudget ||
      !sameBounds(oldProps.bounds, this.props.bounds)
    ) {
      this.destroyResources();
      this.createResources();
    }
  }
  override finalizeState(): void {
    this.destroyResources();
  }
  override draw(): void {
    if (this.props.transitionOpacity <= 0) return;
    const { model, texture } = this.state.resources ?? {};
    if (!model || !texture) return;
    const { content } = this.props;
    const scale = 2 ** (6 - content.index.z);
    const span = 256 * scale;
    model.shaderInputs.setProps({
      life: {
        integerTexture: texture,
        tileOrigin: [content.index.x * span, content.index.y * span],
        cellsPerTexel: scale,
        exact: content.tile.kind === "cells" ? 1 : 0,
        layerOpacity: this.props.transitionOpacity,
      },
    });
    model.draw(this.context.renderPass);
  }
  private createResources(): void {
    const { content, bounds, gpuBudget } = this.props;
    const exact = content.tile.kind === "cells";
    const values = content.tile.values;
    // Texture bytes plus the two app-owned vertex buffers (48-byte positions, 32-byte UVs).
    const release = gpuBudget.reserve(values.byteLength + 80);
    let texture: Texture | undefined;
    let model: Model | undefined;
    try {
      texture = this.context.device.createTexture({
        width: 256,
        height: 256,
        format: exact ? "r8uint" : "r16uint",
        sampler: {
          minFilter: "nearest",
          magFilter: "nearest",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
        },
      });
      texture.writeData(values, {
        width: 256,
        height: 256,
        bytesPerRow: exact ? 256 : 512,
      });
      const span = 256 * 2 ** (6 - content.index.z);
      const origin: [number, number] = [
        content.index.x * span,
        content.index.y * span,
      ];
      const uv = [
        (bounds.left - origin[0]) / span,
        (bounds.top - origin[1]) / span,
        (bounds.right - origin[0]) / span,
        (bounds.bottom - origin[1]) / span,
      ];
      model = new Model(this.context.device, {
        ...this.getShaders(),
        id: this.props.id,
        isInstanced: false,
        geometry: new Geometry({
          topology: "triangle-strip",
          attributes: {
            positions: {
              size: 3,
              value: new Float32Array([
                bounds.left,
                bounds.top,
                0,
                bounds.right,
                bounds.top,
                0,
                bounds.left,
                bounds.bottom,
                0,
                bounds.right,
                bounds.bottom,
                0,
              ]),
            },
            texCoords: {
              size: 2,
              value: new Float32Array([
                uv[0]!,
                uv[1]!,
                uv[2]!,
                uv[1]!,
                uv[0]!,
                uv[3]!,
                uv[2]!,
                uv[3]!,
              ]),
            },
          },
        }),
      });
      this.setState({ resources: { texture, model, release } });
      this.props.onResourceReady(this.props.resourceKey);
    } catch (error) {
      model?.destroy();
      texture?.destroy();
      release();
      this.props.onResourceError(
        error instanceof Error ? error.message : "GPU tile allocation failed",
      );
    }
  }
  private destroyResources(): void {
    const resources = this.state.resources;
    if (!resources) return;
    this.state.resources = undefined;
    this.props.onResourceReleased(this.props.resourceKey);
    resources.model.destroy();
    resources.texture.destroy();
    resources.release();
  }
}

function sameBounds(left: TileBounds, right: TileBounds): boolean {
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom
  );
}

export function clippedBounds(bounds: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): TileBounds {
  return {
    left: Math.max(0, bounds.left),
    top: Math.max(0, bounds.top),
    right: Math.min(WORLD_SIZE, bounds.right),
    bottom: Math.min(WORLD_SIZE, bounds.bottom),
  };
}
