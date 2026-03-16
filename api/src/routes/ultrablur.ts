import apicache from "apicache";
import express from "express";
import * as jpeg from "jpeg-js";
import * as pngjs from "pngjs";

const router = express.Router();
const cache = apicache.middleware;

type UltraBlurColors = {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
};

type RGB = { r: number; g: number; b: number };
type RGB01 = { r: number; g: number; b: number }; // 0..1
type HSL = { h: number; s: number; l: number };
type FitMode = "cover" | "contain";

type DecodedImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

type OkLab = { L: number; a: number; b: number };

type Point = {
  lab: OkLab;
  rgb: RGB01;
  w: number;
  sat: number;
  luma: number;
};

type Cluster = {
  center: OkLab;
  rgb: RGB01;
  totalW: number;
  avgSat: number;
  avgLuma: number;
};

const PNG = (pngjs as unknown as { PNG: any }).PNG as any;

const ULTRABLUR_DEFAULTS = {
  targetSize: 128,
  fit: "cover" as FitMode,
  ignoreAlphaBelow: 16,
  cropBorder: 0.1,
  k: 6,
  maxSamples: 12_000,
  saturationBias: 1.3,
  ignoreNearWhite: true,
  ignoreNearBlack: true,
  minChroma: 0.08,
  minSat: 0.1,
  minOutputSaturation: 0.35,
  saturationBoost: 1.15,
  lightnessShift: -0.08,
  clampS: [0.08, 0.95] as [number, number],
  clampL: [0.1, 0.82] as [number, number],
  soften: 0.12,
  maxBytes: 15 * 1024 * 1024,
  fetchTimeoutMs: 12_000,
};

function ensureHttpUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error("Invalid url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https urls are allowed");
  }

  return parsed;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, value));
}

function rgbToHex({ r, g, b }: RGB): string {
  const to2 = (n: number) => clamp255(Math.round(n)).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase();
}

function hexToRgb(hex: string): RGB {
  const raw = (hex || "").replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) throw new Error(`Invalid hex color: ${hex}`);
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16),
  };
}

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case rn:
        h = ((gn - bn) / d) % 6;
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: clamp01(s), l: clamp01(l) };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  const C = (1 - Math.abs(2 * l - 1)) * s;
  const Hp = (h % 360) / 60;
  const X = C * (1 - Math.abs((Hp % 2) - 1));

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (0 <= Hp && Hp < 1) [r1, g1, b1] = [C, X, 0];
  else if (1 <= Hp && Hp < 2) [r1, g1, b1] = [X, C, 0];
  else if (2 <= Hp && Hp < 3) [r1, g1, b1] = [0, C, X];
  else if (3 <= Hp && Hp < 4) [r1, g1, b1] = [0, X, C];
  else if (4 <= Hp && Hp < 5) [r1, g1, b1] = [X, 0, C];
  else [r1, g1, b1] = [C, 0, X];

  const m = l - C / 2;
  return {
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255,
  };
}

function mixRgb01(a: RGB01, b: RGB01, t: number): RGB01 {
  const tt = clamp01(t);
  return {
    r: a.r + (b.r - a.r) * tt,
    g: a.g + (b.g - a.g) * tt,
    b: a.b + (b.b - a.b) * tt,
  };
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

async function fetchImageBytes(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ULTRABLUR_DEFAULTS.fetchTimeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "image/*,*/*;q=0.8",
        "User-Agent": "discogenius-ultrablur/1.0",
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch image: HTTP ${res.status}`);
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > ULTRABLUR_DEFAULTS.maxBytes) {
      throw new Error("Image too large");
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > ULTRABLUR_DEFAULTS.maxBytes) {
      throw new Error("Image too large");
    }

    return { bytes: buffer, contentType: res.headers.get("content-type") };
  } finally {
    clearTimeout(timeout);
  }
}

function decodeImage(bytes: Uint8Array, contentType: string | null): DecodedImage {
  const buf = Buffer.from(bytes);

  const type = (contentType || "").toLowerCase();
  const looksPng = isPng(bytes) || type.includes("image/png");
  const looksJpeg = isJpeg(bytes) || type.includes("image/jpeg") || type.includes("image/jpg");

  if (looksPng) {
    const decoded = PNG.sync.read(buf);
    return {
      width: decoded.width,
      height: decoded.height,
      data: decoded.data as Uint8Array,
    };
  }

  if (looksJpeg) {
    const decoded = jpeg.decode(buf, { useTArray: true });
    if (!decoded?.data) throw new Error("Failed to decode JPEG");
    return {
      width: decoded.width,
      height: decoded.height,
      data: decoded.data,
    };
  }

  throw new Error("Unsupported image format (expected PNG or JPEG)");
}

function renderFitSquare(image: DecodedImage, size: number, fit: FitMode): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);

  const iw = image.width;
  const ih = image.height;

  if (iw <= 0 || ih <= 0) return out;

  const scale = fit === "cover" ? Math.max(size / iw, size / ih) : Math.min(size / iw, size / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (size - dw) / 2;
  const dy = (size - dh) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = (x - dx) / scale;
      const sy = (y - dy) / scale;

      const di = (y * size + x) * 4;

      if (sx < 0 || sy < 0 || sx >= iw || sy >= ih) {
        out[di + 3] = 0;
        continue;
      }

      const ix = Math.min(iw - 1, Math.max(0, Math.floor(sx)));
      const iy = Math.min(ih - 1, Math.max(0, Math.floor(sy)));
      const si = (iy * iw + ix) * 4;

      out[di] = image.data[si] ?? 0;
      out[di + 1] = image.data[si + 1] ?? 0;
      out[di + 2] = image.data[si + 2] ?? 0;
      out[di + 3] = image.data[si + 3] ?? 255;
    }
  }

  return out;
}

function rgb01ToHex(rgb: RGB01): string {
  return rgbToHex({ r: rgb.r * 255, g: rgb.g * 255, b: rgb.b * 255 });
}

function srgbToLinear(u: number): number {
  const x = clamp01(u);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function rgbToOkLab(rgb: RGB01): OkLab {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

function okLabDist2(p: OkLab, q: OkLab): number {
  const dL = p.L - q.L;
  const da = p.a - q.a;
  const db = p.b - q.b;
  return dL * dL + da * da + db * db;
}

function rgbLuma(rgb: RGB01): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function rgbChroma(rgb: RGB01): number {
  const mx = Math.max(rgb.r, rgb.g, rgb.b);
  const mn = Math.min(rgb.r, rgb.g, rgb.b);
  return mx - mn;
}

function rgbSatApprox(rgb: RGB01): number {
  const mx = Math.max(rgb.r, rgb.g, rgb.b);
  const c = rgbChroma(rgb);
  return mx <= 1e-6 ? 0 : c / mx;
}

function ensureMinSaturation(rgb: RGB01, minS: number): RGB01 {
  const rgb255: RGB = { r: rgb.r * 255, g: rgb.g * 255, b: rgb.b * 255 };
  const hsl = rgbToHsl(rgb255);
  if (hsl.s >= minS) return rgb;
  const boosted = hslToRgb({ h: hsl.h, s: minS, l: hsl.l });
  return { r: boosted.r / 255, g: boosted.g / 255, b: boosted.b / 255 };
}

function averageRgb01(data: Uint8ClampedArray, size: number): RGB01 {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a < 0.5) continue;
    r += (data[i] / 255) * a;
    g += (data[i + 1] / 255) * a;
    b += (data[i + 2] / 255) * a;
    w += a;
  }

  if (w <= 1e-6) return { r: 0.2, g: 0.2, b: 0.2 };
  return { r: r / w, g: g / w, b: b / w };
}

function collectPoints(data: Uint8ClampedArray, size: number): Point[] {
  const points: Point[] = [];

  const border = Math.max(0, Math.floor(size * ULTRABLUR_DEFAULTS.cropBorder));
  const w = Math.max(1, size - border * 2);
  const totalPx = w * w;
  const stride = Math.max(1, Math.floor(Math.sqrt(totalPx / ULTRABLUR_DEFAULTS.maxSamples)));

  for (let y = border; y < size - border; y += stride) {
    for (let x = border; x < size - border; x += stride) {
      const idx = (y * size + x) * 4;
      const a = data[idx + 3];
      if (a < ULTRABLUR_DEFAULTS.ignoreAlphaBelow) continue;

      const rgb: RGB01 = {
        r: data[idx] / 255,
        g: data[idx + 1] / 255,
        b: data[idx + 2] / 255,
      };

      const luma = rgbLuma(rgb);
      const chroma = rgbChroma(rgb);
      const sat = rgbSatApprox(rgb);

      if (chroma < ULTRABLUR_DEFAULTS.minChroma || sat < ULTRABLUR_DEFAULTS.minSat) continue;

      if (ULTRABLUR_DEFAULTS.ignoreNearWhite) {
        if (luma > 0.92 && chroma < 0.18) continue;
      }
      if (ULTRABLUR_DEFAULTS.ignoreNearBlack) {
        if (luma < 0.05) continue;
      }

      const satW = Math.pow(sat, ULTRABLUR_DEFAULTS.saturationBias);
      const lumaW = 1 - Math.min(1, Math.abs(luma - 0.6) / 0.6);
      const weight = (0.15 + 0.85 * satW * (0.4 + 0.6 * lumaW)) * (a / 255);

      points.push({ lab: rgbToOkLab(rgb), rgb, w: weight, sat, luma });
      if (points.length >= ULTRABLUR_DEFAULTS.maxSamples) return points;
    }
  }

  return points;
}

function initCenters(points: Point[], k: number): OkLab[] {
  const kk = Math.max(1, Math.min(k, points.length));
  const centers: OkLab[] = [];

  let best = points[0];
  for (const p of points) {
    if (p.w > best.w) best = p;
  }
  centers.push(best.lab);

  while (centers.length < kk) {
    let bestPoint: Point | null = null;
    let bestScore = -1;

    for (const p of points) {
      let minD = Infinity;
      for (const c of centers) {
        const d = okLabDist2(p.lab, c);
        if (d < minD) minD = d;
      }
      const score = minD * p.w;
      if (score > bestScore) {
        bestScore = score;
        bestPoint = p;
      }
    }

    if (!bestPoint) break;
    centers.push(bestPoint.lab);
  }

  return centers;
}

function kmeans(points: Point[], k: number, iters: number): Cluster[] {
  const centers = initCenters(points, k);
  const kk = centers.length;

  for (let iter = 0; iter < iters; iter++) {
    const sumL = new Array<number>(kk).fill(0);
    const sumA = new Array<number>(kk).fill(0);
    const sumB = new Array<number>(kk).fill(0);
    const sumW = new Array<number>(kk).fill(0);

    for (const p of points) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = okLabDist2(p.lab, centers[c]);
        if (d < bestD) {
          bestD = d;
          bestIdx = c;
        }
      }

      const w = p.w;
      sumL[bestIdx] += p.lab.L * w;
      sumA[bestIdx] += p.lab.a * w;
      sumB[bestIdx] += p.lab.b * w;
      sumW[bestIdx] += w;
    }

    for (let c = 0; c < kk; c++) {
      const w = sumW[c];
      if (w <= 1e-6) continue;
      centers[c] = { L: sumL[c] / w, a: sumA[c] / w, b: sumB[c] / w };
    }
  }

  const clusters: Cluster[] = centers.map((center) => ({
    center,
    rgb: { r: 0, g: 0, b: 0 },
    totalW: 0,
    avgSat: 0,
    avgLuma: 0,
  }));

  for (const p of points) {
    let bestIdx = 0;
    let bestD = Infinity;
    for (let c = 0; c < kk; c++) {
      const d = okLabDist2(p.lab, centers[c]);
      if (d < bestD) {
        bestD = d;
        bestIdx = c;
      }
    }

    const w = p.w;
    clusters[bestIdx].rgb.r += p.rgb.r * w;
    clusters[bestIdx].rgb.g += p.rgb.g * w;
    clusters[bestIdx].rgb.b += p.rgb.b * w;
    clusters[bestIdx].avgSat += p.sat * w;
    clusters[bestIdx].avgLuma += p.luma * w;
    clusters[bestIdx].totalW += w;
  }

  return clusters
    .filter((c) => c.totalW > 1e-6)
    .map((c) => ({
      ...c,
      rgb: { r: c.rgb.r / c.totalW, g: c.rgb.g / c.totalW, b: c.rgb.b / c.totalW },
      avgSat: c.avgSat / c.totalW,
      avgLuma: c.avgLuma / c.totalW,
    }));
}

function pickFour(clusters: Cluster[]): RGB01[] {
  const scored = clusters
    .map((c) => {
      const sat = c.avgSat;
      const l = c.avgLuma;
      const lPenalty = 1 - Math.min(1, Math.abs(l - 0.6) / 0.6);
      const score = c.totalW * (0.35 + 0.65 * sat) * (0.55 + 0.45 * lPenalty);
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];

  const candidates = scored.slice(0, Math.min(10, scored.length));
  const chosen: typeof candidates = [candidates[0]];

  while (chosen.length < 4 && chosen.length < candidates.length) {
    let bestIdx = -1;
    let bestMinD = -1;

    for (let i = 1; i < candidates.length; i++) {
      const cand = candidates[i];
      if (chosen.includes(cand)) continue;

      let minD = Infinity;
      for (const ch of chosen) {
        const d = okLabDist2(cand.center, ch.center);
        if (d < minD) minD = d;
      }

      if (minD > bestMinD) {
        bestMinD = minD;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    chosen.push(candidates[bestIdx]);
  }

  const colors = chosen.map((c) => c.rgb);

  while (colors.length < 4 && colors.length > 0) {
    const last = colors[colors.length - 1];
    colors.push(mixRgb01(last, { r: 0, g: 0, b: 0 }, 0.22 + 0.08 * colors.length));
  }

  return colors;
}

function arrangeToCorners(colors: RGB01[]): { topLeft: RGB01; topRight: RGB01; bottomRight: RGB01; bottomLeft: RGB01 } {
  const labs = colors.map(rgbToOkLab);

  let bestI = 0;
  let bestJ = Math.min(1, colors.length - 1);
  let bestD = -1;

  for (let i = 0; i < labs.length; i++) {
    for (let j = i + 1; j < labs.length; j++) {
      const d = okLabDist2(labs[i], labs[j]);
      if (d > bestD) {
        bestD = d;
        bestI = i;
        bestJ = j;
      }
    }
  }

  const topLeft = colors[bestI];
  const bottomRight = colors[bestJ];

  const rest = colors.filter((_, idx) => idx !== bestI && idx !== bestJ);
  if (rest.length < 2) {
    const c = rest[0] ?? topLeft;
    return { topLeft, topRight: c, bottomRight, bottomLeft: c };
  }

  const a = rest[0];
  const b = rest[1];

  const dATl = okLabDist2(rgbToOkLab(a), rgbToOkLab(topLeft));
  const dBTl = okLabDist2(rgbToOkLab(b), rgbToOkLab(topLeft));
  const dABr = okLabDist2(rgbToOkLab(a), rgbToOkLab(bottomRight));
  const dBBr = okLabDist2(rgbToOkLab(b), rgbToOkLab(bottomRight));

  const sum1 = dATl + dBBr;
  const sum2 = dBTl + dABr;

  const topRight = sum1 <= sum2 ? a : b;
  const bottomLeft = sum1 <= sum2 ? b : a;

  return { topLeft, topRight, bottomRight, bottomLeft };
}

function postProcess(hex: string): string {
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(rgb);

  const s = Math.min(
    ULTRABLUR_DEFAULTS.clampS[1],
    Math.max(ULTRABLUR_DEFAULTS.clampS[0], hsl.s * ULTRABLUR_DEFAULTS.saturationBoost)
  );
  const l = Math.min(
    ULTRABLUR_DEFAULTS.clampL[1],
    Math.max(ULTRABLUR_DEFAULTS.clampL[0], hsl.l + ULTRABLUR_DEFAULTS.lightnessShift)
  );

  return rgbToHex(hslToRgb({ h: hsl.h, s, l }));
}

function extractUltraBlurColorsFromImage(image: DecodedImage): UltraBlurColors {
  const square = renderFitSquare(image, ULTRABLUR_DEFAULTS.targetSize, ULTRABLUR_DEFAULTS.fit);

  const points = collectPoints(square, ULTRABLUR_DEFAULTS.targetSize);

  let picked: RGB01[] = [];
  if (points.length >= 50) {
    const clusters = kmeans(points, ULTRABLUR_DEFAULTS.k, 18);
    picked = pickFour(clusters);
  }

  if (picked.length < 4) {
    const avg = averageRgb01(square, ULTRABLUR_DEFAULTS.targetSize);
    const fallback = rgbChroma(avg) > 0.02 ? avg : { r: 0.18, g: 0.18, b: 0.2 };
    picked = [
      mixRgb01(fallback, { r: 0, g: 0, b: 0 }, 0.15),
      fallback,
      mixRgb01(fallback, { r: 1, g: 1, b: 1 }, 0.08),
      mixRgb01(fallback, { r: 0, g: 0, b: 0 }, 0.32),
    ];
  }

  const tuned = picked.map((c) => ensureMinSaturation(c, ULTRABLUR_DEFAULTS.minOutputSaturation));
  let arranged = arrangeToCorners(tuned);

  const soften = ULTRABLUR_DEFAULTS.soften;
  if (soften > 0) {
    const avg = mixRgb01(
      mixRgb01(arranged.topLeft, arranged.topRight, 0.5),
      mixRgb01(arranged.bottomLeft, arranged.bottomRight, 0.5),
      0.5
    );
    arranged = {
      topLeft: mixRgb01(arranged.topLeft, avg, soften),
      topRight: mixRgb01(arranged.topRight, avg, soften),
      bottomLeft: mixRgb01(arranged.bottomLeft, avg, soften),
      bottomRight: mixRgb01(arranged.bottomRight, avg, soften),
    };
  }

  return {
    topLeft: postProcess(rgb01ToHex(arranged.topLeft)),
    topRight: postProcess(rgb01ToHex(arranged.topRight)),
    bottomLeft: postProcess(rgb01ToHex(arranged.bottomLeft)),
    bottomRight: postProcess(rgb01ToHex(arranged.bottomRight)),
  };
}

async function extractUltraBlurColorsFromUrl(imageUrl: string): Promise<UltraBlurColors> {
  const { bytes, contentType } = await fetchImageBytes(imageUrl);
  const decoded = decodeImage(bytes, contentType);
  return extractUltraBlurColorsFromImage(decoded);
}

/**
 * Plex-style endpoint: returns 4 representative colors extracted from the image.
 * Query: ?url=<http(s)://...>
 */
router.get("/colors", cache("6 hours"), async (req, res) => {
  const url = req.query.url as string | undefined;
  if (!url) {
    res.status(400).json({ detail: "Missing url param" });
    return;
  }

  try {
    const safeUrl = ensureHttpUrl(url);
    const colors = await extractUltraBlurColorsFromUrl(safeUrl.toString());
    res.json(colors);
  } catch (error: any) {
    const message = error?.message || String(error);
    res.status(400).json({ detail: message });
  }
});

export default router;
