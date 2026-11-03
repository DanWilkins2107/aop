/** Colour maths. Stage colours come from user config, so nothing here assumes what they look like. */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

// Pure black, because only black and white together guarantee 4.5:1 on every colour.
const DARK_TEXT = "#000000";
const LIGHT_TEXT = "#ffffff";

/** Reads #rgb, #rgba, #rrggbb and #rrggbbaa, ignoring alpha. Returns null for anything else. */
export function parseHex(color: string): Rgb | null {
  const hex = color.replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const full = hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join("") : hex;
  if (full.length !== 6 && full.length !== 8) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const part = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG relative luminance, from 0 to 1. */
export function luminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return 0;
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

/** WCAG contrast ratio, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on this background. Always at least 4.5:1. */
export function readableText(background: string): string {
  return contrast(DARK_TEXT, background) >= contrast(LIGHT_TEXT, background) ? DARK_TEXT : LIGHT_TEXT;
}

/** Moves `from` towards `to` by `amount`, from 0 to 1. */
export function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  return toHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

/** The nearest shade of `color` with at least this contrast against `background`. */
export function visibleOn(color: string, background: string, minimum = 3): string {
  const toward = luminance(background) < 0.4 ? "#ffffff" : "#000000";
  for (let amount = 0; amount <= 1; amount += 0.05) {
    const shade = mix(color, toward, amount);
    if (contrast(shade, background) >= minimum) return shade;
  }
  return toward;
}

/** A shade light enough to read as a bright card, however dark the configured colour is. */
export function ensureBright(color: string, minimumLuminance = 0.2): string {
  for (let amount = 0; amount <= 1; amount += 0.05) {
    const shade = mix(color, "#ffffff", amount);
    if (luminance(shade) >= minimumLuminance) return shade;
  }
  return "#ffffff";
}
