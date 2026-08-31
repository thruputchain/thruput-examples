import {
  Layer,
  picking,
  project32,
  type DefaultProps,
  type LayerProps,
} from "@deck.gl/core";
import type { Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";

type LifeTextureTile =
  | { kind: "density"; values: Uint16Array }
  | { kind: "cells"; packed: Uint8Array; values: Uint8Array };

export interface LifeTextureData {
  byteLength: number;
  cellsPerTexel: number;
  digest: string;
  tile: LifeTextureTile;
  tileOrigin: [number, number];
}

interface LifeTextureLayerProps extends LayerProps {
  bounds: [left: number, top: number, right: number, bottom: number];
  content: LifeTextureData;
  onResourceCreated: () => void;
  onResourceDestroyed: () => void;
  onFinalize: () => void;
}

interface LifeTextureLayerState {
  [key: string]: unknown;
  model?: Model;
  texture?: Texture;
}

const defaultProps = {} as DefaultProps<LifeTextureLayerProps>;

const lifeUniforms = {
  name: "life",
  fs: `uniform highp usampler2D lifeTexture;
    layout(std140) uniform lifeUniforms {
      vec2 tileOrigin;
      float cellsPerTexel;
      float exact;
    } life;`,
  uniformTypes: {
    tileOrigin: "vec2<f32>",
    cellsPerTexel: "f32",
    exact: "f32",
  },
};

const vertexShader = `#version 300 es
  in vec3 positions;
  in vec2 texCoords;
  out vec2 lifeUv;

  void main(void) {
    geometry.worldPosition = positions;
    geometry.uv = texCoords;
    geometry.pickingColor = vec3(1.0, 0.0, 0.0);
    gl_Position = project_position_to_clipspace(positions, vec3(0.0), vec3(0.0), geometry.position);
    DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
    lifeUv = texCoords;
  }
`;

const fragmentShader = `#version 300 es
  precision highp float;
  precision highp usampler2D;
  in vec2 lifeUv;
  out vec4 fragColor;

  void main(void) {
    ivec2 texel = clamp(ivec2(floor(lifeUv * 256.0)), ivec2(0), ivec2(255));
    uint count = texelFetch(lifeTexture, texel, 0).r;
    vec2 cellMin = life.tileOrigin + vec2(texel) * life.cellsPerTexel;
    vec2 covered = max(min(vec2(10000.0) - cellMin, vec2(life.cellsPerTexel)), vec2(0.0));
    float coveredCells = covered.x * covered.y;
    if (coveredCells == 0.0) {
      discard;
    }
    float density = life.exact > 0.5 ? float(count) : float(count) / coveredCells;
    fragColor = vec4(density, 0.15 + density * 0.7, 0.35 + density * 0.55, 1.0);
    DECKGL_FILTER_COLOR(fragColor, geometry);
  }
`;

export class LifeTextureLayer extends Layer<LifeTextureLayerProps> {
  declare state: LifeTextureLayerState;
  static override layerName = "LifeTextureLayer";
  static override defaultProps = defaultProps;

  override getShaders() {
    return super.getShaders({
      vs: vertexShader,
      fs: fragmentShader,
      modules: [project32, picking, lifeUniforms],
    });
  }

  override initializeState(): void {
    const { bounds, content } = this.props;
    const exact = content.tile.kind === "cells";
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
      texture.writeData(content.tile.values, {
        width: 256,
        height: 256,
        bytesPerRow: exact ? 256 : 512,
      });
      const [left, top, right, bottom] = bounds;
      const tileSpan = 256 * content.cellsPerTexel;
      const textureLeft = (left - content.tileOrigin[0]) / tileSpan;
      const textureTop = (top - content.tileOrigin[1]) / tileSpan;
      const textureRight = (right - content.tileOrigin[0]) / tileSpan;
      const textureBottom = (bottom - content.tileOrigin[1]) / tileSpan;
      model = new Model(this.context.device, {
        ...this.getShaders(),
        id: this.props.id,
        geometry: new Geometry({
          topology: "triangle-strip",
          attributes: {
            positions: {
              size: 3,
              value: new Float32Array([
                left,
                top,
                0,
                right,
                top,
                0,
                left,
                bottom,
                0,
                right,
                bottom,
                0,
              ]),
            },
            texCoords: {
              size: 2,
              value: new Float32Array([
                textureLeft,
                textureTop,
                textureRight,
                textureTop,
                textureLeft,
                textureBottom,
                textureRight,
                textureBottom,
              ]),
            },
          },
        }),
        isInstanced: false,
      });
      this.props.onResourceCreated();
      this.props.onResourceCreated();
      this.setState({ model, texture });
    } catch (error) {
      model?.destroy();
      texture?.destroy();
      throw error;
    }
  }

  override finalizeState(): void {
    if (this.state.model) {
      this.state.model.destroy();
      this.props.onResourceDestroyed();
    }
    if (this.state.texture) {
      this.state.texture.destroy();
      this.props.onResourceDestroyed();
    }
    this.props.onFinalize();
  }

  override draw(): void {
    const { model, texture } = this.state;
    if (!model || !texture) {
      return;
    }
    model.shaderInputs.setProps({
      life: {
        lifeTexture: texture,
        tileOrigin: this.props.content.tileOrigin,
        cellsPerTexel: this.props.content.cellsPerTexel,
        exact: this.props.content.tile.kind === "cells" ? 1 : 0,
      },
    });
    model.draw(this.context.renderPass);
  }
}
