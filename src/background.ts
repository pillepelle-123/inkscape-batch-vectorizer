import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { differenceCiede2000 } from "culori";
import sharp from "sharp";
import type { CustomPlugin, XastElement } from "svgo";
import { ALPHA_MIN, type PaletteColor } from "./analyze.js";

export const KEY_COLOR_DISTANCE = 20;

const KEY_COLOR_CANDIDATES: PaletteColor[] = [
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 128, b: 0 },
  { r: 0, g: 0, b: 255 },
];

const colorDistance = differenceCiede2000();

export function pickKeyColor(palette: PaletteColor[]): PaletteColor {
  let best: PaletteColor = KEY_COLOR_CANDIDATES[0] ?? { r: 255, g: 0, b: 255 };
  let bestScore = -1;
  for (const candidate of KEY_COLOR_CANDIDATES) {
    const score =
      palette.length === 0
        ? Number.POSITIVE_INFINITY
        : Math.min(...palette.map((color) => colorDistance(toCulori(candidate), toCulori(color))));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export async function writeKeyedPng(inputPath: string, keyColor: PaletteColor, medianSize: number): Promise<string> {
  const source = medianSize > 0 ? sharp(inputPath).median(medianSize) : sharp(inputPath);
  const { data, info } = await source.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha < ALPHA_MIN) {
      data[index] = keyColor.r;
      data[index + 1] = keyColor.g;
      data[index + 2] = keyColor.b;
    }
    data[index + 3] = 255;
  }

  const outputPath = path.join(tmpdir(), `vectorizer-${process.pid}-${randomUUID()}.png`);
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(outputPath);
  return outputPath;
}

export function removeKeyColorPlugin(keyColor: PaletteColor, maxDistance = KEY_COLOR_DISTANCE): CustomPlugin & {
  removedPaths: () => number;
} {
  let removed = 0;
  return {
    name: "removeKeyColor",
    removedPaths: () => removed,
    fn: () => ({
      element: {
        exit(node) {
          node.children = node.children.filter((child) => {
            if (child.type !== "element" || child.name !== "path") {
              return true;
            }
            const fill = readFill(child);
            if (!fill || colorDistance(toCulori(fill), toCulori(keyColor)) >= maxDistance) {
              return true;
            }
            removed += 1;
            return false;
          });
        },
      },
    }),
  };
}

function readFill(element: XastElement): PaletteColor | null {
  const style = element.attributes.style ?? "";
  const fromStyle = /(?:^|;)\s*fill:\s*([^;]+)/i.exec(style)?.[1];
  const raw = (fromStyle ?? element.attributes.fill ?? "").trim();
  if (raw.length === 0 || raw === "none") {
    return null;
  }
  return parseColor(raw);
}

function parseColor(value: string): PaletteColor | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex?.[1]) {
    const body = hex[1];
    if (body.length === 3 || body.length === 4) {
      return {
        r: Number.parseInt(`${body[0]}${body[0]}`, 16),
        g: Number.parseInt(`${body[1]}${body[1]}`, 16),
        b: Number.parseInt(`${body[2]}${body[2]}`, 16),
      };
    }
    if (body.length === 6 || body.length === 8) {
      return {
        r: Number.parseInt(body.slice(0, 2), 16),
        g: Number.parseInt(body.slice(2, 4), 16),
        b: Number.parseInt(body.slice(4, 6), 16),
      };
    }
  }

  const channels = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
  if (!channels) {
    return null;
  }
  return {
    r: Number(channels[1]),
    g: Number(channels[2]),
    b: Number(channels[3]),
  };
}

function toCulori(color: PaletteColor): { mode: "rgb"; r: number; g: number; b: number } {
  return { mode: "rgb", r: color.r / 255, g: color.g / 255, b: color.b / 255 };
}
