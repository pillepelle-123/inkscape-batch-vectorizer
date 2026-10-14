import path from "node:path";
import { differenceCiede2000 } from "culori";
import { applyPaletteSync, buildPaletteSync, utils } from "image-q";
import sharp from "sharp";
import type { AutoColors } from "./config.js";

const MAX_EDGE = 256;
const PALETTE_SIZE = 32;
export const ALPHA_MIN = 128;
/** Anteil transparenter Pixel, ab dem der Hintergrund als eigene Farbe gilt. */
const TRANSPARENCY_SHARE = 0.01;
const SMOOTH_OUTLIER_SHARE = 0.05;

export type PaletteColor = {
  r: number;
  g: number;
  b: number;
};

export type ColorAnalysis = {
  colors: number;
  outlierShare: number;
  hasTransparency: boolean;
  smooth: boolean;
  palette: PaletteColor[];
};

type Bucket = {
  r: number;
  g: number;
  b: number;
  count: number;
};

const colorDistance = differenceCiede2000();

export async function analyzeImage(filePath: string, options: AutoColors): Promise<ColorAnalysis> {
  const { data, info } = await sharp(filePath)
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const opaque: number[] = [];
  let transparent = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha < ALPHA_MIN) {
      transparent += 1;
      continue;
    }
    opaque.push(data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0, 255);
  }

  const total = info.width * info.height;
  const hasTransparency = total > 0 && transparent / total >= TRANSPARENCY_SHARE;
  const extension = path.extname(filePath).toLowerCase();
  const isJpeg = extension === ".jpg" || extension === ".jpeg";

  if (opaque.length === 0) {
    return { colors: 0, outlierShare: 0, hasTransparency, smooth: isJpeg, palette: [] };
  }

  const buckets = quantize(opaque);
  const groups = mergeSimilar(buckets, options.minColorDistance);
  const opaqueCount = opaque.length / 4;
  const minimumCount = opaqueCount * options.minColorShare;
  let kept = 0;
  let outlierPixels = 0;
  for (const group of groups) {
    if (group.count < minimumCount) {
      outlierPixels += group.count;
    } else {
      kept += 1;
    }
  }

  const outlierShare = outlierPixels / opaqueCount;
  return {
    colors: kept,
    outlierShare,
    hasTransparency,
    smooth: isJpeg || outlierShare >= SMOOTH_OUTLIER_SHARE,
    palette: groups.map(({ r, g, b }) => ({ r, g, b })),
  };
}

function quantize(opaqueRgba: number[]): Bucket[] {
  const width = opaqueRgba.length / 4;
  const image = utils.PointContainer.fromUint8Array(opaqueRgba, width, 1);
  const palette = buildPaletteSync([image], {
    colors: Math.min(PALETTE_SIZE, width),
    paletteQuantization: "rgbquant",
    colorDistanceFormula: "euclidean",
  });
  const quantized = applyPaletteSync(image, palette, {
    colorDistanceFormula: "euclidean",
    imageQuantization: "nearest",
  });

  const buckets = new Map<number, Bucket>();
  for (const point of quantized.getPointArray()) {
    const key = ((point.r & 255) << 16) | ((point.g & 255) << 8) | (point.b & 255);
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(key, { r: point.r, g: point.g, b: point.b, count: 1 });
    }
  }
  return [...buckets.values()];
}

function mergeSimilar(buckets: Bucket[], minColorDistance: number): Bucket[] {
  const groups: Bucket[] = [];
  const sorted = [...buckets].sort((left, right) => right.count - left.count);
  for (const bucket of sorted) {
    const match = groups.find(
      (group) =>
        colorDistance(toRgb(bucket), toRgb(group)) < minColorDistance,
    );
    if (match) {
      match.count += bucket.count;
    } else {
      groups.push({ ...bucket });
    }
  }
  return groups;
}

function toRgb(bucket: Bucket): { mode: "rgb"; r: number; g: number; b: number } {
  return { mode: "rgb", r: bucket.r / 255, g: bucket.g / 255, b: bucket.b / 255 };
}
