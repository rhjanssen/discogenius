import type { UltraBlurColors } from "@/ultrablur/colors";

/**
 * Client port of the Discogenius UltraBlur GetColors path:
 * sample only chromatic pixels (skip near-white / near-black / grey), k-means in
 * a simple Lab-ish space, pick four diverse saturated colours, arrange to corners.
 *
 * Corner-region averages fail on white-bordered art (Bastille "&") because the
 * accents live in the centre — this whole-image chromatic palette does not.
 */

type RGB01 = { r: number; g: number; b: number };
type Lab = { L: number; a: number; b: number };
type Point = { lab: Lab; rgb: RGB01; w: number; sat: number; luma: number };
type Cluster = {
  center: Lab;
  rgb: RGB01;
  totalW: number;
  avgSat: number;
  avgLuma: number;
};

const TARGET = 96;
const K = 6;
const MAX_SAMPLES = 8_000;
const MIN_CHROMA = 0.08;
const MIN_SAT = 0.12;
const NEAR_WHITE = 0.92;
const NEAR_BLACK = 0.06;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (n: number) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, "0");
  return `#${to2(r * 255)}${to2(g * 255)}${to2(b * 255)}`.toUpperCase();
}

function mixRgb(a: RGB01, b: RGB01, t: number): RGB01 {
  const tt = clamp01(t);
  return {
    r: a.r + (b.r - a.r) * tt,
    g: a.g + (b.g - a.g) * tt,
    b: a.b + (b.b - a.b) * tt,
  };
}

/** Compact sRGB → OKLab-ish for clustering (enough separation for palette picks). */
function rgbToLab(rgb: RGB01): Lab {
  const l = 0.4122214708 * rgb.r + 0.5363325363 * rgb.g + 0.0514459929 * rgb.b;
  const m = 0.2119034982 * rgb.r + 0.6806995451 * rgb.g + 0.1073969566 * rgb.b;
  const s = 0.0883024619 * rgb.r + 0.2817188376 * rgb.g + 0.6299787005 * rgb.b;
  const l_ = Math.cbrt(Math.max(l, 0));
  const m_ = Math.cbrt(Math.max(m, 0));
  const s_ = Math.cbrt(Math.max(s, 0));
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

function labDist2(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dL * dL + da * da + db * db;
}

function chromaSatLuma(rgb: RGB01): { chroma: number; sat: number; luma: number } {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const chroma = max - min;
  const luma = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  const sat = max <= 1e-6 ? 0 : chroma / max;
  return { chroma, sat, luma };
}

function collectPoints(data: Uint8ClampedArray, width: number, height: number): Point[] {
  const points: Point[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / MAX_SAMPLES)));

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a < 16) continue;

      const rgb: RGB01 = {
        r: data[i] / 255,
        g: data[i + 1] / 255,
        b: data[i + 2] / 255,
      };
      const { chroma, sat, luma } = chromaSatLuma(rgb);

      // Only real colours — white borders / black voids / grey never enter the palette.
      if (luma >= NEAR_WHITE && chroma < 0.06) continue;
      if (luma <= NEAR_BLACK) continue;
      if (chroma < MIN_CHROMA || sat < MIN_SAT) continue;

      const satW = Math.pow(sat, 1.35);
      const lumaW = 1 - Math.min(1, Math.abs(luma - 0.55) / 0.55);
      const weight = (0.15 + 0.85 * satW * (0.4 + 0.6 * lumaW)) * (a / 255);

      points.push({ lab: rgbToLab(rgb), rgb, w: weight, sat, luma });
      if (points.length >= MAX_SAMPLES) return points;
    }
  }

  return points;
}

function initCenters(points: Point[], k: number): Lab[] {
  const kk = Math.max(1, Math.min(k, points.length));
  const centers: Lab[] = [];
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
        const d = labDist2(p.lab, c);
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

  for (let iter = 0; iter < iters; iter += 1) {
    const sumL = new Array(kk).fill(0);
    const sumA = new Array(kk).fill(0);
    const sumB = new Array(kk).fill(0);
    const sumW = new Array(kk).fill(0);

    for (const p of points) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c += 1) {
        const d = labDist2(p.lab, centers[c]);
        if (d < bestD) {
          bestD = d;
          bestIdx = c;
        }
      }
      sumL[bestIdx] += p.lab.L * p.w;
      sumA[bestIdx] += p.lab.a * p.w;
      sumB[bestIdx] += p.lab.b * p.w;
      sumW[bestIdx] += p.w;
    }

    for (let c = 0; c < kk; c += 1) {
      if (sumW[c] <= 1e-6) continue;
      centers[c] = {
        L: sumL[c] / sumW[c],
        a: sumA[c] / sumW[c],
        b: sumB[c] / sumW[c],
      };
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
    for (let c = 0; c < kk; c += 1) {
      const d = labDist2(p.lab, centers[c]);
      if (d < bestD) {
        bestD = d;
        bestIdx = c;
      }
    }
    clusters[bestIdx].rgb.r += p.rgb.r * p.w;
    clusters[bestIdx].rgb.g += p.rgb.g * p.w;
    clusters[bestIdx].rgb.b += p.rgb.b * p.w;
    clusters[bestIdx].avgSat += p.sat * p.w;
    clusters[bestIdx].avgLuma += p.luma * p.w;
    clusters[bestIdx].totalW += p.w;
  }

  return clusters
    .filter((c) => c.totalW > 1e-6)
    .map((c) => ({
      ...c,
      rgb: {
        r: c.rgb.r / c.totalW,
        g: c.rgb.g / c.totalW,
        b: c.rgb.b / c.totalW,
      },
      avgSat: c.avgSat / c.totalW,
      avgLuma: c.avgLuma / c.totalW,
    }));
}

function pickFour(clusters: Cluster[]): RGB01[] {
  const scored = clusters
    .map((c) => {
      const lPenalty = 1 - Math.min(1, Math.abs(c.avgLuma - 0.55) / 0.55);
      const score = c.totalW * (0.35 + 0.65 * c.avgSat) * (0.55 + 0.45 * lPenalty);
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];

  const candidates = scored.slice(0, Math.min(10, scored.length));
  const chosen: typeof candidates = [candidates[0]];

  while (chosen.length < 4 && chosen.length < candidates.length) {
    let bestIdx = -1;
    let bestMinD = -1;
    for (let i = 1; i < candidates.length; i += 1) {
      const cand = candidates[i];
      if (chosen.includes(cand)) continue;
      let minD = Infinity;
      for (const ch of chosen) {
        minD = Math.min(minD, labDist2(cand.center, ch.center));
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
    colors.push(mixRgb(last, { r: 0, g: 0, b: 0 }, 0.18 + 0.06 * colors.length));
  }
  return colors;
}

function arrangeToCorners(colors: RGB01[]): UltraBlurColors {
  const labs = colors.map(rgbToLab);
  let bestI = 0;
  let bestJ = Math.min(1, colors.length - 1);
  let bestD = -1;

  for (let i = 0; i < labs.length; i += 1) {
    for (let j = i + 1; j < labs.length; j += 1) {
      const d = labDist2(labs[i], labs[j]);
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

  let topRight: RGB01;
  let bottomLeft: RGB01;
  if (rest.length < 2) {
    const c = rest[0] ?? topLeft;
    topRight = c;
    bottomLeft = c;
  } else {
    const a = rest[0];
    const b = rest[1];
    const sum1 = labDist2(rgbToLab(a), rgbToLab(topLeft)) + labDist2(rgbToLab(b), rgbToLab(bottomRight));
    const sum2 = labDist2(rgbToLab(b), rgbToLab(topLeft)) + labDist2(rgbToLab(a), rgbToLab(bottomRight));
    topRight = sum1 <= sum2 ? a : b;
    bottomLeft = sum1 <= sum2 ? b : a;
  }

  // Soften slightly toward the mean so corners merge in the bake (soften≈0.12).
  const avg = mixRgb(
    mixRgb(topLeft, topRight, 0.5),
    mixRgb(bottomLeft, bottomRight, 0.5),
    0.5,
  );
  const soften = 0.12;
  return {
    topLeft: rgbToHex01(mixRgb(topLeft, avg, soften)),
    topRight: rgbToHex01(mixRgb(topRight, avg, soften)),
    bottomLeft: rgbToHex01(mixRgb(bottomLeft, avg, soften)),
    bottomRight: rgbToHex01(mixRgb(bottomRight, avg, soften)),
  };
}

function rgbToHex01(c: RGB01): string {
  return rgbToHex(c.r, c.g, c.b);
}

/**
 * Prefer the painted hero URL so UltraBlur shares the browser cache with the
 * visible <img>. Remapping to cover-250 used to force a second media-cover
 * request that could await slow on-the-fly resolveAlbumArtwork (~seconds)
 * even after the hero was already on screen.
 */
export function ultrablurSourceUrl(imageUrl: string): string {
  return String(imageUrl || "").trim();
}

export function extractUltraBlurColorsFromImage(image: HTMLImageElement): UltraBlurColors | null {
  if (!image.naturalWidth || !image.naturalHeight) {
    return null;
  }

  const scale = Math.min(1, TARGET / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(8, Math.round(image.naturalWidth * scale));
  const height = Math.max(8, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(image, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const points = collectPoints(data, width, height);

    let picked: RGB01[] = [];
    if (points.length >= 24) {
      picked = pickFour(kmeans(points, K, 12));
    }

    if (picked.length < 4) {
      let r = 0;
      let g = 0;
      let b = 0;
      let w = 0;
      for (const p of points) {
        r += p.rgb.r * p.w;
        g += p.rgb.g * p.w;
        b += p.rgb.b * p.w;
        w += p.w;
      }
      const fallback: RGB01 = w > 0
        ? { r: r / w, g: g / w, b: b / w }
        : { r: 0.18, g: 0.22, b: 0.28 };
      picked = [
        mixRgb(fallback, { r: 0, g: 0, b: 0 }, 0.12),
        fallback,
        mixRgb(fallback, { r: 1, g: 1, b: 1 }, 0.06),
        mixRgb(fallback, { r: 0, g: 0, b: 0 }, 0.22),
      ];
    }

    return arrangeToCorners(picked.slice(0, 4));
  } catch {
    return null;
  }
}
