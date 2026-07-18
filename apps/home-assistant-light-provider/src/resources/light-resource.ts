import type { NormalizedLightState } from "../types.js";

export function publicLightState(state: NormalizedLightState): Record<string, unknown> {
  return {
    resourceId: state.resourceId,
    power: state.power,
    reachable: state.reachable,
    brightnessPercent: state.brightnessPercent,
    observedAt: state.observedAt,
  };
}
