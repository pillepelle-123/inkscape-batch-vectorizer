import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { CustomPlugin, XastElement } from "svgo";
import { ALPHA_MIN, type PaletteColor } from "./analyze.js";

const COLOR_BIN = 16;

export function findEdgeColor(data: Uint8Array, width: number, height: number): PaletteColor {
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  const isOpaque = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return false;
    }
    return (data[(y * width + x) * 4 + 3] ?? 0) >= ALPHA_MIN;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if ((data[index + 3] ?? 0) < ALPHA_MIN) {
        continue;
      }
      const onEdge = !isOpaque(x - 1, y) || !isOpaque(x + 1, y) || !isOpaque(x, y - 1) || !isOpaque(x, y + 1);
      if (!onEdge) {
        continue;
      }
      const red = data[index] ?? 0;
      const green = data[index + 1] ?? 0;
      const blue = data[index + 2] ?? 0;
      const key =
        (Math.floor(red / COLOR_BIN) << 8) |
        (Math.floor(green / COLOR_BIN) << 4) |
        Math.floor(blue / COLOR_BIN);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.r += red;
        bucket.g += green;
        bucket.b += blue;
        bucket.count += 1;
      } else {
        buckets.set(key, { r: red, g: green, b: blue, count: 1 });
      }
    }
  }

  let best: { r: number; g: number; b: number; count: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) {
      best = bucket;
    }
  }
  if (!best || best.count === 0) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: Math.round(best.r / best.count),
    g: Math.round(best.g / best.count),
    b: Math.round(best.b / best.count),
  };
}

export async function writeEdgeFilledPng(inputPath: string, medianSize: number): Promise<string> {
  const source = medianSize > 0 ? sharp(inputPath).median(medianSize) : sharp(inputPath);
  const { data, info } = await source.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const edge = findEdgeColor(data, info.width, info.height);
  for (let index = 0; index < data.length; index += 4) {
    if ((data[index + 3] ?? 0) < ALPHA_MIN) {
      data[index] = edge.r;
      data[index + 1] = edge.g;
      data[index + 2] = edge.b;
    }
    data[index + 3] = 255;
  }
  return writeRawPng(data, info.width, info.height);
}

export async function writeAlphaMaskPng(inputPath: string): Promise<string> {
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const ink = (data[index + 3] ?? 0) >= ALPHA_MIN ? 0 : 255;
    data[index] = ink;
    data[index + 1] = ink;
    data[index + 2] = ink;
    data[index + 3] = 255;
  }
  return writeRawPng(data, info.width, info.height);
}

export function applySilhouetteClipPlugin(silhouetteD: string): CustomPlugin {
  return {
    name: "applySilhouetteClip",
    fn: () => ({
      element: {
        enter(node) {
          if (node.name !== "svg" || hasSilhouetteClip(node)) {
            return;
          }
          const clipPath: XastElement = {
            type: "element",
            name: "clipPath",
            attributes: { id: "vectorizer-silhouette" },
            children: [
              {
                type: "element",
                name: "path",
                attributes: { d: silhouetteD },
                children: [],
              },
            ],
          };
          let defs = node.children.find(
            (child): child is XastElement => child.type === "element" && child.name === "defs",
          );
          if (!defs) {
            defs = { type: "element", name: "defs", attributes: {}, children: [] };
            node.children.unshift(defs);
          }
          defs.children.push(clipPath);
          const content = node.children.filter((child) => !(child.type === "element" && child.name === "defs"));
          const definitions = node.children.filter((child) => child.type === "element" && child.name === "defs");
          const group: XastElement = {
            type: "element",
            name: "g",
            attributes: { "clip-path": "url(#vectorizer-silhouette)" },
            children: content,
          };
          node.children = [...definitions, group];
        },
      },
    }),
  };
}

function hasSilhouetteClip(node: XastElement): boolean {
  return node.children.some(
    (child) => child.type === "element" && child.name === "g" && Boolean(child.attributes["clip-path"]),
  );
}

async function writeRawPng(data: Buffer, width: number, height: number): Promise<string> {
  const outputPath = path.join(tmpdir(), `vectorizer-${process.pid}-${randomUUID()}.png`);
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
  return outputPath;
}
