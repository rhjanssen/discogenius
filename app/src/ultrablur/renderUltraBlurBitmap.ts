import type { UltraBlurColors } from "@/ultrablur/colors";
import { getBrandTokensFromPalette } from "@/theme/fluentThemeDesigner";

/**
 * Plexamp-style UltraBlur bake.
 *
 * Hue/chroma identity comes from k-means corner colours. Luminance is normalised
 * through Fluent's brand ramp (`getBrandTokensFromPalette`) so cover brightness
 * does not drive wash brightness:
 *  - dark → brand step 40 (rich, saturated)
 *  - light → brand step 120 (bright tint) mixed onto white paper
 *
 * Matches Fluent Mica layering: the bake is the opaque foundation; UI chrome
 * sits on top with low-opacity LayerFill-style surfaces (see Layout / cards).
 */
const BITMAP_W = 480;
const BITMAP_H = 270;
const BAKE_BLUR_PX = 42;
const FALLOFF = 2.05;
/** Field vs paper/void. Light stays mostly white with a soft pastel tint. */
const DARK_MIX = 0.78;
const LIGHT_MIX = 0.24;
/** Fluent BrandVariants steps — same L for every corner within a theme. */
const DARK_BRAND_STEP = 40 as const;
const LIGHT_BRAND_STEP = 120 as const;
/** Pure-ish white paper so light mode reads as white + colour, not grey wash. */
const LIGHT_PAPER = { r: 255, g: 255, b: 255 };
const DARK_VOID = { r: 6, g: 8, b: 12 };
const NOISE_AMP = 0.012;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const raw = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
    return { r: 64, g: 64, b: 64 };
  }
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16),
  };
}

function srgbToLinear(u: number): number {
  const x = clamp01(u);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linear01ToSrgb8(lin: number): number {
  const l = clamp01(lin);
  const c = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(clamp01(c) * 255);
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Remap a k-means corner through Fluent's brand palette: keep hue, lock L to the
 * theme step so bright and dark covers land at the same wash brightness.
 */
function themeToneCorner(
  hex: string,
  isDarkMode: boolean,
): { r: number; g: number; b: number } {
  const step = isDarkMode ? DARK_BRAND_STEP : LIGHT_BRAND_STEP;
  const key = hex.startsWith("#") ? hex : `#${hex}`;
  let remapped = key;
  try {
    const brand = getBrandTokensFromPalette(key);
    remapped = brand[step] || key;
  } catch {
    remapped = key;
  }
  const rgb = parseHex(remapped);
  return {
    r: srgbToLinear(rgb.r / 255),
    g: srgbToLinear(rgb.g / 255),
    b: srgbToLinear(rgb.b / 255),
  };
}

const BAKE_CACHE_VERSION = "ub10";
const bakeCache = new Map<string, string>();

/**
 * Bake a soft 4-corner ultrablur wash into a static PNG data URL.
 */
export function renderUltraBlurDataUrl(colors: UltraBlurColors, isDarkMode: boolean): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  const cacheKey = `${BAKE_CACHE_VERSION}:${isDarkMode ? "d" : "l"}:${colors.topLeft}:${colors.topRight}:${colors.bottomLeft}:${colors.bottomRight}`;
  const cached = bakeCache.get(cacheKey);
  if (cached) return cached;

  const tl = themeToneCorner(colors.topLeft, isDarkMode);
  const tr = themeToneCorner(colors.topRight, isDarkMode);
  const bl = themeToneCorner(colors.bottomLeft, isDarkMode);
  const br = themeToneCorner(colors.bottomRight, isDarkMode);
  const paper = isDarkMode
    ? {
        r: srgbToLinear(DARK_VOID.r / 255),
        g: srgbToLinear(DARK_VOID.g / 255),
        b: srgbToLinear(DARK_VOID.b / 255),
      }
    : {
        r: srgbToLinear(LIGHT_PAPER.r / 255),
        g: srgbToLinear(LIGHT_PAPER.g / 255),
        b: srgbToLinear(LIGHT_PAPER.b / 255),
      };
  const mix = isDarkMode ? DARK_MIX : LIGHT_MIX;
  const rand = mulberry32(fnv1a32(cacheKey));
  const invW = BITMAP_W > 1 ? 1 / (BITMAP_W - 1) : 0;
  const invH = BITMAP_H > 1 ? 1 / (BITMAP_H - 1) : 0;

  const src = document.createElement("canvas");
  src.width = BITMAP_W;
  src.height = BITMAP_H;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  if (!sctx) return null;

  const image = sctx.createImageData(BITMAP_W, BITMAP_H);
  for (let y = 0; y < BITMAP_H; y += 1) {
    const ny = y * invH;
    const dy0 = ny * ny;
    const dy1 = (1 - ny) * (1 - ny);
    for (let x = 0; x < BITMAP_W; x += 1) {
      const nx = x * invW;
      const dx0 = nx * nx;
      const dx1 = (1 - nx) * (1 - nx);
      const wTL = Math.exp(-FALLOFF * (dx0 + dy0));
      const wTR = Math.exp(-FALLOFF * (dx1 + dy0));
      const wBL = Math.exp(-FALLOFF * (dx0 + dy1));
      const wBR = Math.exp(-FALLOFF * (dx1 + dy1));
      const sum = wTL + wTR + wBL + wBR || 1;
      const noise = (rand() - 0.5) * NOISE_AMP;

      const fieldR = (tl.r * wTL + tr.r * wTR + bl.r * wBL + br.r * wBR) / sum;
      const fieldG = (tl.g * wTL + tr.g * wTR + bl.g * wBL + br.g * wBR) / sum;
      const fieldB = (tl.b * wTL + tr.b * wTR + bl.b * wBL + br.b * wBR) / sum;

      const rLin = clamp01(fieldR * mix + paper.r * (1 - mix) + noise);
      const gLin = clamp01(fieldG * mix + paper.g * (1 - mix) + noise);
      const bLin = clamp01(fieldB * mix + paper.b * (1 - mix) + noise);

      const i = (y * BITMAP_W + x) * 4;
      image.data[i] = linear01ToSrgb8(rLin);
      image.data[i + 1] = linear01ToSrgb8(gLin);
      image.data[i + 2] = linear01ToSrgb8(bLin);
      image.data[i + 3] = 255;
    }
  }
  sctx.putImageData(image, 0, 0);

  const pad = BAKE_BLUR_PX * 2;
  const dest = document.createElement("canvas");
  dest.width = BITMAP_W + pad * 2;
  dest.height = BITMAP_H + pad * 2;
  const dctx = dest.getContext("2d");
  if (!dctx) return null;

  dctx.imageSmoothingEnabled = true;
  dctx.drawImage(src, 0, 0, dest.width, dest.height);
  dctx.filter = `blur(${BAKE_BLUR_PX}px)`;
  dctx.drawImage(src, pad, pad);
  dctx.filter = "none";

  const cropped = document.createElement("canvas");
  cropped.width = BITMAP_W;
  cropped.height = BITMAP_H;
  const cctx = cropped.getContext("2d");
  if (!cctx) return null;
  cctx.drawImage(dest, pad, pad, BITMAP_W, BITMAP_H, 0, 0, BITMAP_W, BITMAP_H);

  try {
    const dataUrl = cropped.toDataURL("image/png");
    if (bakeCache.size > 48) {
      const oldest = bakeCache.keys().next().value;
      if (oldest) bakeCache.delete(oldest);
    }
    bakeCache.set(cacheKey, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}
