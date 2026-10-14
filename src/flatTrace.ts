import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { applySilhouetteClipPlugin } from "./background.js";
import { dilateIntoOutline, luminance, type FlatAnalysis, type FlatColor } from "./flat.js";
import { traceMask } from "./inkscape.js";
import { optimizeSvgFile } from "./svgo.js";
import type { PluginConfig } from "svgo";

export async function traceFlat(options: {
  analysis: FlatAnalysis;
  inkscapePath: string;
  outputPath: string;
  speckles: number;
  smoothCorners: number;
  optimize: number;
  timeoutMs: number;
  dilate: number;
  svgo: boolean;
  svgoPrecision: number;
  clip: boolean;
}): Promise<{ ok: true; colors: number } | { ok: false; message: string }> {
  const { analysis } = options;
  if (analysis.palette.length === 0) {
    return { ok: false, message: "Keine Flächenfarben gefunden" };
  }
  const temporary: string[] = [];
  try {
    const base = largest(analysis.palette);
    const outline = darkest(analysis.palette);
    const layers = analysis.palette
      .map((color, index) => ({ color, index }))
      .filter((layer) => layer.index !== base)
      .sort((left, right) => {
        if (left.index === outline) {
          return 1;
        }
        if (right.index === outline) {
          return -1;
        }
        return right.color.count - left.color.count;
      });

    let viewBox: string | null = null;
    let silhouette: string | null = null;
    if (options.clip) {
      const alphaPath = await writeAlphaFromLabels(analysis);
      temporary.push(alphaPath);
      const traced = await traceMask({
        inkscapePath: options.inkscapePath,
        inputPath: alphaPath,
        speckles: options.speckles,
        smoothCorners: options.smoothCorners,
        optimize: options.optimize,
        timeoutMs: options.timeoutMs,
        missingMessage: "Silhouette nicht gefunden",
      });
      if (!traced.ok) {
        return traced;
      }
      viewBox = traced.viewBox;
      silhouette = traced.d;
    }

    const paths: Array<{ hex: string; d: string }> = [];
    for (const layer of layers) {
      const mask =
        layer.index === outline
          ? maskOf(analysis, layer.index)
          : dilateIntoOutline(analysis.labels, analysis.width, analysis.height, layer.index, outline, options.dilate);
      if (!mask.some((value) => value === 1)) {
        continue;
      }
      const maskPath = await writeMaskPng(mask, analysis.width, analysis.height);
      temporary.push(maskPath);
      const traced = await traceMask({
        inkscapePath: options.inkscapePath,
        inputPath: maskPath,
        speckles: options.speckles,
        smoothCorners: options.smoothCorners,
        optimize: options.optimize,
        timeoutMs: options.timeoutMs,
      });
      if (!traced.ok) {
        return traced;
      }
      if (viewBox === null) {
        viewBox = traced.viewBox;
      } else if (traced.viewBox !== viewBox) {
        return { ok: false, message: "Die viewBox der Farbflächen stimmt nicht überein" };
      }
      paths.push({ hex: layer.color.hex, d: traced.d });
    }

    if (viewBox === null) {
      const probe = await writeMaskPng(filled(analysis.width * analysis.height), analysis.width, analysis.height);
      temporary.push(probe);
      const traced = await traceMask({
        inkscapePath: options.inkscapePath,
        inputPath: probe,
        speckles: 0,
        smoothCorners: options.smoothCorners,
        optimize: options.optimize,
        timeoutMs: options.timeoutMs,
      });
      if (!traced.ok) {
        return traced;
      }
      viewBox = traced.viewBox;
    }

    const baseColor = analysis.palette[base];
    if (!baseColor) {
      return { ok: false, message: "Keine Grundfarbe gefunden" };
    }
    const basePath = silhouette ?? rectangle(viewBox);
    const body = [
      pathTag(baseColor.hex, basePath),
      ...paths.map((layer) => pathTag(layer.hex, layer.d)),
    ].join("");
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
    await writeFile(options.outputPath, svg, "utf8");

    const plugins: PluginConfig[] = [];
    if (options.clip && silhouette) {
      plugins.push(applySilhouetteClipPlugin(silhouette));
    }
    if (options.svgo || plugins.length > 0) {
      await optimizeSvgFile(options.outputPath, options.svgoPrecision, {
        compress: options.svgo,
        plugins,
      });
    }
    return { ok: true, colors: analysis.palette.length };
  } finally {
    const { rm } = await import("node:fs/promises");
    await Promise.all(temporary.map((file) => rm(file, { force: true })));
  }
}

function largest(palette: FlatColor[]): number {
  let best = 0;
  for (let index = 1; index < palette.length; index += 1) {
    if ((palette[index]?.count ?? 0) > (palette[best]?.count ?? 0)) {
      best = index;
    }
  }
  return best;
}

function darkest(palette: FlatColor[]): number {
  let best = 0;
  for (let index = 1; index < palette.length; index += 1) {
    const color = palette[index];
    const current = palette[best];
    if (color && current && luminance(color) < luminance(current)) {
      best = index;
    }
  }
  return best;
}

function maskOf(analysis: FlatAnalysis, colorIndex: number): Uint8Array {
  const mask = new Uint8Array(analysis.labels.length);
  for (let index = 0; index < analysis.labels.length; index += 1) {
    if (analysis.labels[index] === colorIndex) {
      mask[index] = 1;
    }
  }
  return mask;
}

async function writeMaskPng(mask: Uint8Array, width: number, height: number): Promise<string> {
  const raw = Buffer.alloc(width * height * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const ink = mask[index] === 1 ? 0 : 255;
    const pixel = index * 4;
    raw[pixel] = ink;
    raw[pixel + 1] = ink;
    raw[pixel + 2] = ink;
    raw[pixel + 3] = 255;
  }
  const outputPath = path.join(tmpdir(), `vectorizer-flat-${process.pid}-${randomUUID()}.png`);
  await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
  return outputPath;
}

async function writeAlphaFromLabels(analysis: FlatAnalysis): Promise<string> {
  const mask = new Uint8Array(analysis.labels.length);
  for (let index = 0; index < analysis.labels.length; index += 1) {
    if ((analysis.labels[index] ?? -1) >= 0) {
      mask[index] = 1;
    }
  }
  return writeMaskPng(mask, analysis.width, analysis.height);
}

function filled(length: number): Uint8Array {
  return new Uint8Array(length).fill(1);
}

function rectangle(viewBox: string): string {
  const [x = 0, y = 0, width = 0, height = 0] = viewBox.split(/[\s,]+/).map(Number);
  return `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
}

function pathTag(hex: string, d: string): string {
  return `<path style="fill:${hex}" d="${d}"/>`;
}
