import { differenceCiede2000 } from "culori";
import { applyPaletteSync, buildPaletteSync, utils } from "image-q";
import sharp from "sharp";
import { ALPHA_MIN, type PaletteColor } from "./analyze.js";
import type { FlatColors } from "./config.js";

const PALETTE_SIZE = 32;
const MAX_SAMPLE = 80_000;
const EDGE_DISTANCE = 15;
const UNEXPLAINED_DISTANCE = 8;
/** Anteil der Kernpixel, unter dem eine Farbe als Tupfer gilt. */
const MIN_SHARE = 0.001;
/**
 * Mittelwert des Farbabstands, ab dem das Motiv kein Flächenbild mehr ist.
 * Geeicht an den Pastell-Doodles (höchstens 3,13) gegen Löwe (3,83) und Botanik (4,67).
 */
export const RESIDUAL_LIMIT = 3.4;
/**
 * Anteil der Kernpixel mit großem Farbabstand, ab dem das Motiv kein Flächenbild mehr ist.
 * Geeicht an der Binderklammer (2,1 %) gegen den Clown (4,2 %) und den Löwen (4,7 %).
 */
export const UNEXPLAINED_LIMIT = 0.03;

const colorDistance = differenceCiede2000();

export type FlatColor = PaletteColor & {
  count: number;
  hex: string;
};

export type FlatAnalysis = {
  isFlat: boolean;
  palette: FlatColor[];
  /** -1 für transparente Pixel, sonst der Index in `palette`. */
  labels: Int16Array;
  width: number;
  height: number;
  residual: number;
  unexplainedShare: number;
  hasTransparency: boolean;
};

export async function analyzeFlat(inputPath: string, options: FlatColors): Promise<FlatAnalysis> {
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const count = width * height;
  const opaque = new Uint8Array(count);
  let transparent = 0;
  for (let index = 0; index < count; index += 1) {
    if ((data[index * 4 + 3] ?? 0) >= ALPHA_MIN) {
      opaque[index] = 1;
    } else {
      transparent += 1;
    }
  }

  const edge = markEdges(data, opaque, width, height);
  const core: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (opaque[index] && !edge[index]) {
      core.push(index);
    }
  }

  const candidates =
    core.length === 0 ? [] : mergeColors(averageCores(data, core, quantizeSample(data, core)), options.colorDistance);
  const kept = candidates.filter((color) => color.count >= core.length * MIN_SHARE);
  const palette = (kept.length > 0 ? kept : candidates.slice(0, 1)).map((color) => ({
    ...color,
    count: 0,
    hex: toHex(color),
  }));

  const labels = new Int16Array(count).fill(-1);
  let residualSum = 0;
  let unexplained = 0;
  for (let index = 0; index < count; index += 1) {
    if (!opaque[index] || palette.length === 0) {
      continue;
    }
    const nearest = nearestColor(data, index, palette);
    labels[index] = nearest.index;
    const bucket = palette[nearest.index];
    if (bucket) {
      bucket.count += 1;
    }
    if (!edge[index]) {
      residualSum += nearest.distance;
      if (nearest.distance > UNEXPLAINED_DISTANCE) {
        unexplained += 1;
      }
    }
  }

  const residual = core.length === 0 ? 0 : residualSum / core.length;
  const unexplainedShare = core.length === 0 ? 0 : unexplained / core.length;
  const isFlat =
    palette.length > 0 &&
    palette.length <= options.maxColors &&
    unexplainedShare < UNEXPLAINED_LIMIT &&
    residual < RESIDUAL_LIMIT;

  return {
    isFlat,
    palette,
    labels,
    width,
    height,
    residual,
    unexplainedShare,
    hasTransparency: count > 0 && transparent / count >= 0.01,
  };
}

/** Erweitert eine Farbfläche nur in Pixel der Umrissfarbe. */
export function dilateIntoOutline(
  labels: Int16Array,
  width: number,
  height: number,
  colorIndex: number,
  outlineIndex: number,
  radius: number,
): Uint8Array {
  const mask = new Uint8Array(labels.length);
  const distance = new Int16Array(labels.length).fill(-1);
  const queue: number[] = [];
  for (let index = 0; index < labels.length; index += 1) {
    if (labels[index] !== colorIndex) {
      continue;
    }
    mask[index] = 1;
    distance[index] = 0;
    queue.push(index);
  }
  let cursor = 0;
  while (cursor < queue.length) {
    const index = queue[cursor] as number;
    cursor += 1;
    const steps = distance[index] ?? 0;
    if (steps >= radius) {
      continue;
    }
    const x = index % width;
    const y = (index - x) / width;
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const;
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        continue;
      }
      const next = ny * width + nx;
      if ((distance[next] ?? -1) >= 0 || labels[next] !== outlineIndex) {
        continue;
      }
      distance[next] = steps + 1;
      mask[next] = 1;
      queue.push(next);
    }
  }
  return mask;
}

export function luminance(color: PaletteColor): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

function markEdges(data: Buffer, opaque: Uint8Array, width: number, height: number): Uint8Array {
  const edge = new Uint8Array(opaque.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!opaque[index]) {
        continue;
      }
      const color = packed(data, index);
      for (let dy = -1; dy <= 1 && !edge[index]; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            continue;
          }
          const neighbor = ny * width + nx;
          if (!opaque[neighbor]) {
            continue;
          }
          if (accurateDistance(color, packed(data, neighbor)) > EDGE_DISTANCE) {
            edge[index] = 1;
            break;
          }
        }
      }
    }
  }
  return edge;
}

function quantizeSample(data: Buffer, core: number[]): PaletteColor[] {
  const stride = Math.max(1, Math.ceil(core.length / MAX_SAMPLE));
  const sample: number[] = [];
  for (let index = 0; index < core.length; index += stride) {
    const pixel = (core[index] ?? 0) * 4;
    sample.push(data[pixel] ?? 0, data[pixel + 1] ?? 0, data[pixel + 2] ?? 0, 255);
  }
  if (sample.length === 0) {
    return [];
  }
  const width = sample.length / 4;
  const image = utils.PointContainer.fromUint8Array(sample, width, 1);
  const built = buildPaletteSync([image], {
    colors: Math.min(PALETTE_SIZE, width),
    paletteQuantization: "rgbquant",
    colorDistanceFormula: "euclidean",
  });
  const quantized = applyPaletteSync(image, built, {
    colorDistanceFormula: "euclidean",
    imageQuantization: "nearest",
  });
  const seen = new Map<number, PaletteColor>();
  for (const point of quantized.getPointArray()) {
    const key = ((point.r & 255) << 16) | ((point.g & 255) << 8) | (point.b & 255);
    if (!seen.has(key)) {
      seen.set(key, { r: point.r, g: point.g, b: point.b });
    }
  }
  return [...seen.values()];
}

function averageCores(
  data: Buffer,
  core: number[],
  colors: PaletteColor[],
): Array<PaletteColor & { count: number }> {
  const sums = colors.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
  for (const index of core) {
    const nearest = nearestColor(data, index, colors);
    const bucket = sums[nearest.index];
    if (!bucket) {
      continue;
    }
    const pixel = index * 4;
    bucket.r += data[pixel] ?? 0;
    bucket.g += data[pixel + 1] ?? 0;
    bucket.b += data[pixel + 2] ?? 0;
    bucket.count += 1;
  }
  return sums
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => ({
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
      count: bucket.count,
    }));
}

function mergeColors(
  colors: Array<PaletteColor & { count: number }>,
  maxDistance: number,
): Array<PaletteColor & { count: number }> {
  const groups: Array<PaletteColor & { count: number }> = [];
  const sorted = [...colors].sort((left, right) => right.count - left.count);
  for (const color of sorted) {
    const match = groups.find((group) => accurateDistance(packColor(group), packColor(color)) < maxDistance);
    if (!match) {
      groups.push({ ...color });
      continue;
    }
    const count = match.count + color.count;
    match.r = Math.round((match.r * match.count + color.r * color.count) / count);
    match.g = Math.round((match.g * match.count + color.g * color.count) / count);
    match.b = Math.round((match.b * match.count + color.b * color.count) / count);
    match.count = count;
  }
  return groups;
}

function nearestColor(
  data: Buffer,
  index: number,
  palette: PaletteColor[],
): { index: number; distance: number } {
  const color = packed(data, index);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let paletteIndex = 0; paletteIndex < palette.length; paletteIndex += 1) {
    const candidate = palette[paletteIndex];
    if (!candidate) {
      continue;
    }
    const distance = accurateDistance(color, packColor(candidate));
    if (distance < bestDistance) {
      best = paletteIndex;
      bestDistance = distance;
    }
  }
  return { index: best, distance: bestDistance };
}

const distanceCache = new Map<string, number>();

function accurateDistance(left: number, right: number): number {
  if (left === right) {
    return 0;
  }
  const key = left < right ? `${left}:${right}` : `${right}:${left}`;
  const cached = distanceCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const value = colorDistance(toCulori(left), toCulori(right));
  distanceCache.set(key, value);
  return value;
}

function packed(data: Buffer, index: number): number {
  const pixel = index * 4;
  return ((data[pixel] ?? 0) << 16) | ((data[pixel + 1] ?? 0) << 8) | (data[pixel + 2] ?? 0);
}

function packColor(color: PaletteColor): number {
  return (color.r << 16) | (color.g << 8) | color.b;
}

function toCulori(color: number): { mode: "rgb"; r: number; g: number; b: number } {
  return { mode: "rgb", r: ((color >> 16) & 255) / 255, g: ((color >> 8) & 255) / 255, b: (color & 255) / 255 };
}

function toHex(color: PaletteColor): string {
  return `#${[color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
