import sharp from "sharp";
import { ALPHA_MIN } from "./analyze.js";
import type { AutoDetail } from "./config.js";

const BRIGHT_MIN = 200;
const DARK_MAX = 60;
/** Unter 8 Pixeln löscht schon ein Median 3 die Fläche und würde speckles auf fast 0 ziehen. */
const MIN_AREA = 8;
const MAX_AREA = 400;
const MIN_FILL = 0.5;
const MAX_ASPECT = 2.5;
const MIN_ENCLOSURE = 0.8;
const RING = 2;
const SURVIVAL = 0.7;
const SPECKLES_FACTOR = 0.8;

/** Mittlere Helligkeitsabweichung zum Median 3, ab der ein Median-Filter lohnt. Am Löwen und an flachen Assets geeicht. */
const NOISE_MEDIAN_3 = 2.5;
/** Ab hier wäre Median 5 die erste Wahl, sofern die Glanzpunkte ihn überstehen. */
const NOISE_MEDIAN_5 = 6;

export type DetailAnalysis = {
  speckles: number;
  medianSize: number;
  highlights: number;
  smallestHighlight: number | null;
  noise: number;
};

type Kind = "bright" | "dark";

type Highlight = {
  kind: Kind;
  pixels: number[];
  area: number;
};

export type HighlightSpot = {
  x: number;
  y: number;
  kind: "bright" | "dark";
  area: number;
};

export async function highlightSpots(inputPath: string): Promise<HighlightSpot[]> {
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const luma = toLuma(data, info.width, info.height);
  return findHighlights(luma, info.width, info.height).map((item) => {
    let sumX = 0;
    let sumY = 0;
    for (const index of item.pixels) {
      sumX += index % info.width;
      sumY += Math.floor(index / info.width);
    }
    return {
      x: Math.round(sumX / item.area),
      y: Math.round(sumY / item.area),
      kind: item.kind,
      area: item.area,
    };
  });
}

export async function analyzeDetail(inputPath: string, options: AutoDetail): Promise<DetailAnalysis> {
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const luma = toLuma(data, info.width, info.height);
  const highlights = findHighlights(luma, info.width, info.height);
  const median3 = await filteredLuma(data, info.width, info.height, 3);
  const noise = meanAbsDiff(luma, median3);
  const medianSize = await chooseMedian(data, info.width, info.height, median3, highlights, noise);
  const measured =
    medianSize === 0 ? highlights : findHighlights(await filteredLuma(data, info.width, info.height, medianSize), info.width, info.height);
  const smallestHighlight = measured.length === 0 ? null : Math.min(...measured.map((item) => item.area));
  const speckles =
    smallestHighlight === null
      ? options.maxSpeckles
      : clamp(Math.floor(SPECKLES_FACTOR * smallestHighlight), 0, options.maxSpeckles);

  return {
    speckles,
    medianSize,
    highlights: highlights.length,
    smallestHighlight,
    noise,
  };
}

async function chooseMedian(
  rgba: Buffer,
  width: number,
  height: number,
  median3: Int16Array,
  highlights: Highlight[],
  noise: number,
): Promise<number> {
  const preferred = noise >= NOISE_MEDIAN_5 ? 5 : noise >= NOISE_MEDIAN_3 ? 3 : 0;
  const candidates = preferred === 5 ? [5, 3, 0] : preferred === 3 ? [3, 0] : [0];
  for (const kernel of candidates) {
    if (kernel === 0) {
      return 0;
    }
    const filtered = kernel === 3 ? median3 : await filteredLuma(rgba, width, height, kernel);
    if (highlights.every((highlight) => survival(highlight, filtered) >= SURVIVAL)) {
      return kernel;
    }
  }
  return 0;
}

function survival(highlight: Highlight, luma: Int16Array): number {
  let kept = 0;
  for (const index of highlight.pixels) {
    const value = luma[index] ?? -1;
    if (matches(value, highlight.kind)) {
      kept += 1;
    }
  }
  return highlight.area === 0 ? 0 : kept / highlight.area;
}

function findHighlights(luma: Int16Array, width: number, height: number): Highlight[] {
  const visited = new Uint8Array(luma.length);
  const found: Highlight[] = [];
  for (let index = 0; index < luma.length; index += 1) {
    if (visited[index]) {
      continue;
    }
    const value = luma[index] ?? -1;
    const kind = kindOf(value);
    if (!kind) {
      visited[index] = 1;
      continue;
    }
    const highlight = flood(luma, visited, width, height, index, kind);
    if (highlight && accepts(highlight, luma, width, height)) {
      found.push(highlight);
    }
  }
  return found;
}

function flood(
  luma: Int16Array,
  visited: Uint8Array,
  width: number,
  height: number,
  start: number,
  kind: Kind,
): Highlight | null {
  const pixels: number[] = [];
  const stack = [start];
  visited[start] = 1;
  let oversized = false;

  while (stack.length > 0) {
    const index = stack.pop() as number;
    const x = index % width;
    const y = (index - x) / width;
    if (!oversized) {
      pixels.push(index);
      if (pixels.length > MAX_AREA) {
        oversized = true;
        pixels.length = 0;
      }
    }
    pushNeighbor(stack, visited, luma, width, height, x - 1, y, kind);
    pushNeighbor(stack, visited, luma, width, height, x + 1, y, kind);
    pushNeighbor(stack, visited, luma, width, height, x, y - 1, kind);
    pushNeighbor(stack, visited, luma, width, height, x, y + 1, kind);
  }

  if (oversized || pixels.length === 0) {
    return null;
  }
  return { kind, pixels, area: pixels.length };
}

function pushNeighbor(
  stack: number[],
  visited: Uint8Array,
  luma: Int16Array,
  width: number,
  height: number,
  x: number,
  y: number,
  kind: Kind,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }
  const index = y * width + x;
  if (visited[index] || !matches(luma[index] ?? -1, kind)) {
    return;
  }
  visited[index] = 1;
  stack.push(index);
}

function accepts(highlight: Highlight, luma: Int16Array, width: number, height: number): boolean {
  if (highlight.area < MIN_AREA || highlight.area > MAX_AREA) {
    return false;
  }
  const bounds = boundsOf(highlight.pixels, width);
  const boxWidth = bounds.maxX - bounds.minX + 1;
  const boxHeight = bounds.maxY - bounds.minY + 1;
  if (highlight.area / (boxWidth * boxHeight) < MIN_FILL) {
    return false;
  }
  if (Math.max(boxWidth, boxHeight) / Math.min(boxWidth, boxHeight) > MAX_ASPECT) {
    return false;
  }
  const ring = ringStats(luma, width, height, highlight);
  return ring.opaque >= 8 && ring.opposite / ring.opaque >= MIN_ENCLOSURE;
}

function boundsOf(pixels: number[], width: number): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = width;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = 0;
  let maxY = 0;
  for (const index of pixels) {
    const x = index % width;
    const y = (index - x) / width;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function ringStats(
  luma: Int16Array,
  width: number,
  height: number,
  highlight: Highlight,
): { opaque: number; opposite: number } {
  const members = new Set(highlight.pixels);
  const seen = new Set<number>();
  let classified = 0;
  let opposite = 0;
  for (const index of highlight.pixels) {
    const x = index % width;
    const y = (index - x) / width;
    for (let dy = -RING; dy <= RING; dy += 1) {
      for (let dx = -RING; dx <= RING; dx += 1) {
        if (dx === 0 && dy === 0) {
          continue;
        }
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          continue;
        }
        const neighbor = ny * width + nx;
        if (members.has(neighbor) || seen.has(neighbor)) {
          continue;
        }
        seen.add(neighbor);
        const value = luma[neighbor] ?? -1;
        if (value < 0 || !isClassified(value)) {
          continue;
        }
        classified += 1;
        if (highlight.kind === "bright" ? isDark(value) : isBright(value)) {
          opposite += 1;
        }
      }
    }
  }
  return { opaque: classified, opposite };
}

function isClassified(value: number): boolean {
  return isBright(value) || isDark(value);
}

function kindOf(value: number): Kind | null {
  if (isBright(value)) {
    return "bright";
  }
  if (isDark(value)) {
    return "dark";
  }
  return null;
}

function matches(value: number, kind: Kind): boolean {
  return kind === "bright" ? isBright(value) : isDark(value);
}

function isBright(value: number): boolean {
  return value >= BRIGHT_MIN;
}

function isDark(value: number): boolean {
  return value >= 0 && value <= DARK_MAX;
}

function toLuma(rgba: Buffer, width: number, height: number): Int16Array {
  const luma = new Int16Array(width * height);
  for (let index = 0, pixel = 0; index < luma.length; index += 1, pixel += 4) {
    if ((rgba[pixel + 3] ?? 0) < ALPHA_MIN) {
      luma[index] = -1;
      continue;
    }
    luma[index] = Math.round(0.2126 * (rgba[pixel] ?? 0) + 0.7152 * (rgba[pixel + 1] ?? 0) + 0.0722 * (rgba[pixel + 2] ?? 0));
  }
  return luma;
}

async function filteredLuma(rgba: Buffer, width: number, height: number, kernel: number): Promise<Int16Array> {
  const filtered = await sharp(rgba, { raw: { width, height, channels: 4 } }).median(kernel).ensureAlpha().raw().toBuffer();
  const luma = new Int16Array(width * height);
  for (let index = 0, pixel = 0; index < luma.length; index += 1, pixel += 4) {
    if ((rgba[pixel + 3] ?? 0) < ALPHA_MIN) {
      luma[index] = -1;
      continue;
    }
    luma[index] = Math.round(
      0.2126 * (filtered[pixel] ?? 0) + 0.7152 * (filtered[pixel + 1] ?? 0) + 0.0722 * (filtered[pixel + 2] ?? 0),
    );
  }
  return luma;
}

function meanAbsDiff(original: Int16Array, filtered: Int16Array): number {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < original.length; index += 1) {
    const left = original[index] ?? -1;
    if (left < 0) {
      continue;
    }
    sum += Math.abs(left - (filtered[index] ?? 0));
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
