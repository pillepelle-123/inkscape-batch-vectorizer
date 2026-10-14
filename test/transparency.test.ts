import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { differenceCiede2000 } from "culori";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { analyzeImage } from "../src/analyze.ts";
import { analyzeFlat } from "../src/flat.ts";
import { traceFlat } from "../src/flatTrace.ts";
import { analyzeDetail } from "../src/detail.ts";
import { applySilhouetteClipPlugin, writeAlphaMaskPng, writeEdgeFilledPng } from "../src/background.ts";
import type { SimplifySettings, TraceSettings } from "../src/config.ts";
import { readViewBox, resolveInkscapeBinary, traceSilhouette, traceToSvg } from "../src/inkscape.ts";
import { writeMedianPng } from "../src/preprocess.ts";
import { resolveTrace } from "../src/simplify.ts";
import { optimizeSvgFile } from "../src/svgo.ts";

const width = 128;
const height = 128;
const simplify: SimplifySettings = {
  level: "off",
  maxColors: null,
  medianSize: null,
  svgo: true,
  svgoPrecision: 2,
};

describe("Transparenz mit Silhouette", () => {
  it("behält die weiße Pupille und macht den Hintergrund transparent", async () => {
    const source = await writeRaw("eye.png", eyePixels(), 4);
    const svgPath = await vectorize(source, {
      scans: "auto",
      smooth: false,
      stack: true,
      removeBackground: true,
      speckles: 0,
      smoothCorners: 1,
      optimize: 0.2,
    });

    const sample = await sampleSvg(svgPath);
    const corner = sample(2, 2);
    const pupil = sample(64, 58);
    const body = sample(30, 90);
    expect(corner[3]).toBeLessThan(16);
    expect(pupil[3]).toBeGreaterThan(200);
    expect(pupil[0]).toBeGreaterThan(200);
    expect(body[3]).toBeGreaterThan(200);
    expect(body[0]).toBeGreaterThan(body[2]);
  }, 90_000);

  it("lässt innerhalb der Motivfläche keine Lücken, auch bei groben Trace-Werten", async () => {
    const size = 180;
    const pixels = outlinedBlocks(size);
    const source = await writeRaw("blocks.png", pixels, 4, size, size);
    const svgPath = await vectorize(source, {
      scans: 3,
      smooth: false,
      stack: true,
      removeBackground: true,
      speckles: 240,
      smoothCorners: 1.05,
      optimize: 3.25,
    });

    const raw = await raster(svgPath, size);
    let opaque = 0;
    let holes = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if ((pixels[index + 3] ?? 0) < 128) {
        continue;
      }
      opaque += 1;
      if ((raw[index + 3] ?? 0) < 16) {
        holes += 1;
      }
    }
    expect(holes / opaque).toBeLessThan(0.005);
  }, 90_000);

  it("behält einen kleinen Glanzpunkt, wenn speckles und der Median automatisch sind", async () => {
    const size = 96;
    const pixels = Buffer.alloc(size * size * 4, 0);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const value = 150 + ((x * 13 + y * 7) % 11) - 5;
        const index = (y * size + x) * 4;
        pixels[index] = value;
        pixels[index + 1] = Math.max(0, value - 20);
        pixels[index + 2] = 40;
        pixels[index + 3] = 255;
      }
    }
    const paint = (x: number, y: number, red: number, green: number, blue: number) => {
      const index = (y * size + x) * 4;
      pixels[index] = red;
      pixels[index + 1] = green;
      pixels[index + 2] = blue;
      pixels[index + 3] = 255;
    };
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x - 48;
        const dy = y - 48;
        if (dx * dx + dy * dy <= 16 * 16) {
          paint(x, y, 8, 8, 8);
        }
        if (dx * dx + dy * dy <= 3 * 3) {
          paint(x, y, 250, 250, 250);
        }
      }
    }
    const source = await writeRaw("auto-eye.png", pixels, 4, size, size);
    const detail = await analyzeDetail(source, { maxSpeckles: 100 });
    expect(detail.speckles).toBeLessThan(detail.smallestHighlight ?? 0);
    const svgPath = await vectorize(
      source,
      {
        scans: 6,
        smooth: false,
        stack: true,
        removeBackground: false,
        speckles: "auto",
        smoothCorners: 1,
        optimize: 0.2,
      },
      { ...simplify, medianSize: "auto" },
      detail,
    );
    const raw = await raster(svgPath, size);
    const pupil = raw.subarray((48 * size + 48) * 4, (48 * size + 48) * 4 + 4);
    expect(pupil[0]).toBeGreaterThan(200);
    expect(pupil[1]).toBeGreaterThan(200);
    expect(pupil[2]).toBeGreaterThan(200);
  }, 90_000);

  it("behält den weißen Hintergrund eines JPEG", async () => {
    const pixels = Buffer.alloc(width * height * 3, 255);
    for (let y = 40; y < 90; y += 1) {
      for (let x = 40; x < 90; x += 1) {
        const index = (y * width + x) * 3;
        pixels[index] = 200;
        pixels[index + 1] = 30;
        pixels[index + 2] = 30;
      }
    }
    const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-jpeg-"));
    const source = path.join(dir, "card.jpg");
    await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg().toFile(source);
    const analysis = await analyzeImage(source, { minColorDistance: 10, minColorShare: 0.005 });
    expect(analysis.hasTransparency).toBe(false);
    const svgPath = await vectorize(source, {
      scans: 2,
      smooth: true,
      stack: false,
      removeBackground: true,
      speckles: 0,
      smoothCorners: 1,
      optimize: 0.2,
    });
    const corner = (await sampleSvg(svgPath))(4, 4);
    expect(corner[3]).toBeGreaterThan(200);
    expect(corner[0]).toBeGreaterThan(200);
  }, 90_000);

  it("hält im Flächen-Modus das Gelb bis an den Rand und den Hintergrund transparent", async () => {
    const size = 96;
    const pixels = Buffer.alloc(size * size * 4, 0);
    const paint = (x0: number, y0: number, w: number, h: number, red: number, green: number, blue: number) => {
      for (let y = y0; y < y0 + h; y += 1) {
        for (let x = x0; x < x0 + w; x += 1) {
          const index = (y * size + x) * 4;
          pixels[index] = red;
          pixels[index + 1] = green;
          pixels[index + 2] = blue;
          pixels[index + 3] = 255;
        }
      }
    };
    paint(8, 8, 80, 80, 10, 10, 10);
    paint(14, 14, 68, 68, 245, 245, 245);
    paint(20, 24, 24, 48, 255, 170, 190);
    paint(52, 24, 24, 48, 255, 214, 102);
    const source = await writeRaw("flat-doodle.png", pixels, 4, size, size);
    const flat = await analyzeFlat(source, { mode: "flat", colorDistance: 12, maxColors: 12, dilate: 2 });
    expect(flat.isFlat).toBe(true);
    const svgPath = path.join(path.dirname(source), "flat-doodle.svg");
    const inkscape = await resolveInkscapeBinary(null);
    const traced = await traceFlat({
      analysis: flat,
      inkscapePath: inkscape,
      outputPath: svgPath,
      speckles: 0,
      smoothCorners: 1,
      optimize: 0.2,
      timeoutMs: 60_000,
      dilate: 2,
      svgo: true,
      svgoPrecision: 2,
      clip: true,
    });
    expect(traced.ok).toBe(true);
    const raw = await raster(svgPath, size);
    const distance = differenceCiede2000();
    const yellow = { mode: "rgb" as const, r: 255 / 255, g: 214 / 255, b: 102 / 255 };
    let checked = 0;
    let off = 0;
    for (let y = 24; y < 72; y += 1) {
      for (let x = 52; x < 76; x += 1) {
        const index = (y * size + x) * 4;
        checked += 1;
        const delta = distance(yellow, {
          mode: "rgb",
          r: (raw[index] ?? 0) / 255,
          g: (raw[index + 1] ?? 0) / 255,
          b: (raw[index + 2] ?? 0) / 255,
        });
        if (delta > 10) {
          off += 1;
        }
      }
    }
    expect(off / checked).toBeLessThan(0.005);
    expect(raw[3]).toBeLessThan(16);
  }, 90_000);
});

async function vectorize(
  source: string,
  trace: TraceSettings,
  simplifySettings = simplify,
  detail: Awaited<ReturnType<typeof analyzeDetail>> | null = null,
): Promise<string> {
  const analysis = await analyzeImage(source, { minColorDistance: 10, minColorShare: 0.005 });
  const effective = resolveTrace({ trace, simplify: simplifySettings, analysis, detail });
  const inkscape = await resolveInkscapeBinary(null);
  const svgPath = path.join(path.dirname(source), `${path.parse(source).name}.svg`);
  const temporary: string[] = [];
  try {
    let inputPath = source;
    if (effective.clipBackground) {
      inputPath = await writeEdgeFilledPng(source, effective.medianSize);
      temporary.push(inputPath);
    } else if (effective.medianSize > 0) {
      inputPath = await writeMedianPng(source, effective.medianSize);
      temporary.push(inputPath);
    }
    const traced = await traceToSvg({
      inkscapePath: inkscape,
      inputPath,
      outputPath: svgPath,
      trace: effective,
      timeoutMs: 60_000,
    });
    expect(traced.ok).toBe(true);
    const plugins = [];
    if (effective.clipBackground) {
      const mask = await writeAlphaMaskPng(source);
      temporary.push(mask);
      const silhouette = await traceSilhouette({
        inkscapePath: inkscape,
        inputPath: mask,
        speckles: effective.speckles,
        smoothCorners: effective.smoothCorners,
        optimize: effective.optimize,
        timeoutMs: 60_000,
      });
      expect(silhouette.ok).toBe(true);
      if (!silhouette.ok) {
        return svgPath;
      }
      const colorSvg = await readFile(svgPath, "utf8");
      expect(readViewBox(colorSvg)).toBe(silhouette.viewBox);
      plugins.push(applySilhouetteClipPlugin(silhouette.d));
    }
    await optimizeSvgFile(svgPath, 2, { compress: true, plugins });
    return svgPath;
  } finally {
    await Promise.all(temporary.map((file) => rm(file, { force: true })));
  }
}

function eyePixels(): Buffer {
  const pixels = Buffer.alloc(width * height * 4, 0);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    const index = (y * width + x) * 4;
    pixels[index] = r;
    pixels[index + 1] = g;
    pixels[index + 2] = b;
    pixels[index + 3] = 255;
  };
  for (let y = 24; y < 104; y += 1) {
    for (let x = 20; x < 108; x += 1) {
      set(x, y, 220, 40, 40);
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - 64;
      const dy = y - 58;
      if (dx * dx + dy * dy <= 26 * 26) {
        set(x, y, 10, 10, 10);
      }
      if (dx * dx + dy * dy <= 10 * 10) {
        set(x, y, 245, 245, 245);
      }
    }
  }
  return pixels;
}

function outlinedBlocks(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4, 0);
  for (let y = 20; y < size - 20; y += 1) {
    for (let x = 20; x < size - 20; x += 1) {
      const index = (y * size + x) * 4;
      const edge = x < 28 || x >= size - 28 || y < 28 || y >= size - 28;
      const left = x < size / 2;
      pixels[index] = edge ? 8 : left ? 240 : 190;
      pixels[index + 1] = edge ? 8 : left ? 220 : 40;
      pixels[index + 2] = edge ? 8 : left ? 30 : 40;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

async function writeRaw(name: string, pixels: Buffer, channels: number, imageWidth = width, imageHeight = height): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-silhouette-"));
  const file = path.join(dir, name);
  await sharp(pixels, { raw: { width: imageWidth, height: imageHeight, channels } }).png().toFile(file);
  return file;
}

async function sampleSvg(svgPath: string): Promise<(x: number, y: number) => Buffer> {
  const raw = await raster(svgPath, width);
  return (x, y) => raw.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
}

async function raster(svgPath: string, targetWidth: number): Promise<Buffer> {
  const svg = await readFile(svgPath, "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: targetWidth } }).render().asPng();
  const raw = await sharp(png).ensureAlpha().resize(targetWidth, targetWidth, { fit: "fill" }).raw().toBuffer();
  return raw;
}
