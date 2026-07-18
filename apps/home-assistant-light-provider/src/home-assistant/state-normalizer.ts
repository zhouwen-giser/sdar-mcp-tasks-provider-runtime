import type { HomeAssistantState, LightPower, NormalizedLightState } from "../types.js";

const brightnessModes = new Set(["brightness", "color_temp", "hs", "xy", "rgb", "rgbw", "rgbww"]);

export function percentToHaBrightness(percent: number): number {
  return Math.max(1, Math.min(255, Math.round((percent / 100) * 255)));
}

export function haBrightnessToPercent(brightness: number): number {
  return Math.max(1, Math.min(100, Math.round((brightness / 255) * 100)));
}

export function normalizeLightState(
  resourceId: string,
  state: HomeAssistantState,
): NormalizedLightState {
  const supportedColorModes = Array.isArray(state.attributes.supported_color_modes)
    ? state.attributes.supported_color_modes.filter(
        (mode): mode is string => typeof mode === "string",
      )
    : [];
  const brightness =
    typeof state.attributes.brightness === "number" ? state.attributes.brightness : null;
  const supportsBrightness =
    brightness !== null || supportedColorModes.some((mode) => brightnessModes.has(mode));
  const power = normalizePower(state.state);
  return {
    resourceId,
    power,
    reachable: power === "on" || power === "off",
    brightnessPercent:
      brightness === null || power !== "on" ? null : haBrightnessToPercent(brightness),
    observedAt: state.last_updated,
    supportedColorModes,
    supportsBrightness,
  };
}

function normalizePower(value: string): LightPower {
  if (value === "on" || value === "off" || value === "unavailable") return value;
  return "unknown";
}
