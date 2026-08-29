import {
  Layer,
  project32,
  type DefaultProps,
  type LayerProps,
  type UpdateParameters,
} from "@deck.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { ActiveByteBudget } from "./budget";
import type { TileBounds } from "./pyramid";

interface Props extends LayerProps {
  readonly bounds: TileBounds;
  readonly gpuBudget: ActiveByteBudget;
}
interface Resources {
  readonly model: Model;
  readonly release: () => void;
}
interface State {
  [key: string]: unknown;
  resources: Resources | undefined;
}

const vertex = `#version 300 es
in vec3 positions;
void main(void) {
  geometry.worldPosition = positions;
  gl_Position = project_position_to_clipspace(positions, vec3(0.), vec3(0.), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
}`;
const fragment = `#version 300 es
precision highp float;
out vec4 fragColor;
void main(void) {
  float stripe = step(.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.));
  vec3 color = mix(vec3(.10, .045, .035), vec3(.42, .16, .075), stripe);
  fragColor = vec4(color, 1.);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}`;

export class UnavailableTileLayer extends Layer<Props> {
  declare state: State;
  static override layerName = "UnavailableTileLayer";
  static override defaultProps = {} as DefaultProps<Props>;

  override getShaders() {
    return super.getShaders({ vs: vertex, fs: fragment, modules: [project32] });
  }
  override initializeState(): void {
    this.createResources();
  }
  override updateState({ oldProps }: UpdateParameters<this>): void {
    if (
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
    this.state.resources?.model.draw(this.context.renderPass);
  }
  private createResources(): void {
    const { bounds, gpuBudget } = this.props;
    const release = gpuBudget.reserve(48);
    let model: Model | undefined;
    try {
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
          },
        }),
      });
      this.setState({ resources: { model, release } });
    } catch (cause) {
      model?.destroy();
      release();
      throw cause;
    }
  }
  private destroyResources(): void {
    const resources = this.state.resources;
    if (!resources) return;
    this.state.resources = undefined;
    resources.model.destroy();
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
