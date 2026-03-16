import type { UltraBlurColors } from "@/ultrablur/colors";
import { hexToRgb, rgba } from "@/ultrablur/color";

export type RenderUltraBlurOptions = {
  width: number;
  height: number;
  lowResScale?: number;
  blurPx?: number;
  overlayDarken?: number;
  vignette?: number;
  noiseAmount?: number;
  blobCount?: number;
  seed?: string;
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function srgb8ToLinear01(c8: number): number {
  const c = clamp01(c8 / 255);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linear01ToSrgb8(lin: number): number {
  const l = clamp01(lin);
  const c = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(clamp01(c) * 255);
}

function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillFourCornerGradient(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  c: UltraBlurColors
) {
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  const tl = hexToRgb(c.topLeft);
  const tr = hexToRgb(c.topRight);
  const bl = hexToRgb(c.bottomLeft);
  const br = hexToRgb(c.bottomRight);

  // Build a 4-corner (PlexAmp-style) gradient. Instead of a purely bilinear "mesh" (which tends to
  // wash out into a center blob), we use a radial falloff from each corner so the colors
  // clearly "emerge" from the corners and blend towards the middle.
  const tlLin = { r: srgb8ToLinear01(tl.r), g: srgb8ToLinear01(tl.g), b: srgb8ToLinear01(tl.b) };
  const trLin = { r: srgb8ToLinear01(tr.r), g: srgb8ToLinear01(tr.g), b: srgb8ToLinear01(tr.b) };
  const blLin = { r: srgb8ToLinear01(bl.r), g: srgb8ToLinear01(bl.g), b: srgb8ToLinear01(bl.b) };
  const brLin = { r: srgb8ToLinear01(br.r), g: srgb8ToLinear01(br.g), b: srgb8ToLinear01(br.b) };

  const img = ctx.createImageData(w, h);
  const d = img.data;

  const invW = w > 1 ? 1 / (w - 1) : 0;
  const invH = h > 1 ? 1 / (h - 1) : 0;

  // Controls how quickly colors decay away from corners.
  // Higher = tighter corner glows; lower = more uniform blend.
  const falloff = 4.6;

  let i = 0;
  for (let y = 0; y < h; y++) {
    const ny = y * invH;
    const dy0 = ny * ny;
    const dy1 = (1 - ny) * (1 - ny);
    for (let x = 0; x < w; x++) {
      const nx = x * invW;
      const dx0 = nx * nx;
      const dx1 = (1 - nx) * (1 - nx);

      const wTL = Math.exp(-falloff * (dx0 + dy0));
      const wTR = Math.exp(-falloff * (dx1 + dy0));
      const wBL = Math.exp(-falloff * (dx0 + dy1));
      const wBR = Math.exp(-falloff * (dx1 + dy1));

      const sum = wTL + wTR + wBL + wBR || 1;

      const rLin = (tlLin.r * wTL + trLin.r * wTR + blLin.r * wBL + brLin.r * wBR) / sum;
      const gLin = (tlLin.g * wTL + trLin.g * wTR + blLin.g * wBL + brLin.g * wBR) / sum;
      const bLin = (tlLin.b * wTL + trLin.b * wTR + blLin.b * wBL + brLin.b * wBR) / sum;

      d[i++] = linear01ToSrgb8(rLin);
      d[i++] = linear01ToSrgb8(gLin);
      d[i++] = linear01ToSrgb8(bLin);
      d[i++] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

function addBlobs(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  c: UltraBlurColors,
  count: number,
  rand: () => number
) {
  const palette = [c.topLeft, c.topRight, c.bottomLeft, c.bottomRight];
  for (let i = 0; i < count; i++) {
    const color = palette[Math.floor(rand() * palette.length)];
    const cx = rand() * w;
    const cy = rand() * h;
    const r = (0.22 + rand() * 0.38) * Math.min(w, h);

    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, rgba(color, 0.18));
    g.addColorStop(1, rgba(color, 0.0));

    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

function addVignette(ctx: CanvasRenderingContext2D, w: number, h: number, strength: number) {
  if (strength <= 0) return;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.max(w, h) * 0.75;

  const g = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${Math.min(0.9, strength)})`);

  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function addNoise(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, rand: () => number) {
  if (amount <= 0) return;

  const tile = createCanvas(128, 128);
  const tctx = tile.getContext("2d", { willReadFrequently: true });
  if (!tctx) return;

  const img = tctx.createImageData(tile.width, tile.height);
  const d = img.data;

  const alpha = Math.max(0, Math.min(1, amount)) * 55;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.floor(rand() * 256);
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = Math.floor(alpha * rand());
  }
  tctx.putImageData(img, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = "soft-light";
  ctx.globalAlpha = 0.55;
  for (let y = 0; y < h; y += tile.height) {
    for (let x = 0; x < w; x += tile.width) {
      ctx.drawImage(tile, x, y);
    }
  }
  ctx.restore();
}

export function renderUltraBlur(colors: UltraBlurColors, options: RenderUltraBlurOptions): HTMLCanvasElement {
  const {
    width,
    height,
    lowResScale = 0.22,
    blurPx = 60,
    overlayDarken = 0,
    vignette = 0,
    noiseAmount = 0.18,
    blobCount = 0,
    seed = `${width}x${height}:${colors.topLeft}:${colors.topRight}:${colors.bottomLeft}:${colors.bottomRight}`,
  } = options;

  const rand = mulberry32(fnv1a32(seed));

  const lw = Math.max(96, Math.round(width * lowResScale));
  const lh = Math.max(72, Math.round(height * lowResScale));

  const low = createCanvas(lw, lh);
  const lctx = low.getContext("2d");
  if (!lctx) throw new Error("2D canvas not available");

  fillFourCornerGradient(lctx, lw, lh, colors);
  addBlobs(lctx, lw, lh, colors, blobCount, rand);

  const out = createCanvas(width, height);
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D canvas not available");

  ctx.imageSmoothingEnabled = true;
  // @ts-expect-error older TS libs might not include this union; safe in modern browsers
  ctx.imageSmoothingQuality = "high";

  ctx.save();
  // "Smoked glass" look: slightly darkened, high saturation, low contrast boost.
  // Keep this theme-agnostic; theme adaptation happens via the overlay layer.
  ctx.filter = `blur(${Math.max(0, blurPx)}px) saturate(1.55) contrast(1.05) brightness(0.84)`;
  ctx.drawImage(low, 0, 0, width, height);
  ctx.restore();

  if (overlayDarken > 0) {
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, Math.max(0, overlayDarken))})`;
    ctx.fillRect(0, 0, width, height);
  }

  addVignette(ctx, width, height, vignette);
  addNoise(ctx, width, height, noiseAmount, rand);

  return out;
}
