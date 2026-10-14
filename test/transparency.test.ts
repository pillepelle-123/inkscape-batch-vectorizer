import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { analyzeImage } from "../src/analyze.ts";
import { pickKeyColor, removeKeyColorPlugin, writeKeyedPng } from "../src/background.ts";
import { traceToSvg, resolveInkscapeBinary } from "../src/inkscape.ts";
import { resolveTrace } from "../src/simplify.ts";
import { optimizeSvgFile } from "../src/svgo.ts";

const width = 128;
const height = 128;

describe("Transparenz mit Schlüsselfarbe", () => {
  it("behält die weiße Pupille und macht den Hintergrund transparent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-eye-"));
    const source = path.join(dir, "eye.png");
    await sharp(eyePixels(), { raw: { width, height, channels: 4 } }).png().toFile(source);

    const analysis = await analyzeImage(source, { minColorDistance: 10, minColorShare: 0.005 });
    const effective = resolveTrace({
      trace: {
        scans: "auto",
        smooth: false,
        stack: true,
        removeBackground: true,
        speckles: 0,
        smoothCorners: 1,
        optimize: 0.2,
      },
      simplify: { level: "off", maxColors: null, medianSize: null, svgo: true, svgoPrecision: 2 },
      analysis,
    });
    const keyColor = pickKeyColor(analysis.palette);
    const keyed = await writeKeyedPng(source, keyColor, 0);
    const svgPath = path.join(dir, "eye.svg");
    const inkscape = await resolveInkscapeBinary(null);
    const traced = await traceToSvg({
      inkscapePath: inkscape,
      inputPath: keyed,
      outputPath: svgPath,
      trace: effective,
      timeoutMs: 60_000,
    });
    expect(traced.ok).toBe(true);

    const plugin = removeKeyColorPlugin(keyColor);
    await optimizeSvgFile(svgPath, 2, { compress: true, plugins: [plugin] });
    expect(plugin.removedPaths()).toBeGreaterThan(0);

    const sample = await sampleSvg(svgPath);
    const corner = sample(2, 2);
    const pupil = sample(64, 58);
    const body = sample(30, 90);
    expect(corner[3]).toBeLessThan(16);
    expect(pupil[3]).toBeGreaterThan(200);
    expect(pupil[0]).toBeGreaterThan(200);
    expect(pupil[1]).toBeGreaterThan(200);
    expect(pupil[2]).toBeGreaterThan(200);
    expect(body[3]).toBeGreaterThan(200);
    expect(body[0]).toBeGreaterThan(body[2]);
  }, 60_000);

  it("behält den weißen Hintergrund eines JPEG", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-jpeg-"));
    const source = path.join(dir, "card.jpg");
    const pixels = Buffer.alloc(width * height * 3, 255);
    for (let y = 40; y < 90; y += 1) {
      for (let x = 40; x < 90; x += 1) {
        const index = (y * width + x) * 3;
        pixels[index] = 200;
        pixels[index + 1] = 30;
        pixels[index + 2] = 30;
      }
    }
    await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg().toFile(source);

    const analysis = await analyzeImage(source, { minColorDistance: 10, minColorShare: 0.005 });
    expect(analysis.hasTransparency).toBe(false);
    const effective = resolveTrace({
      trace: {
        scans: 2,
        smooth: true,
        stack: false,
        removeBackground: true,
        speckles: 0,
        smoothCorners: 1,
        optimize: 0.2,
      },
      simplify: { level: "off", maxColors: null, medianSize: null, svgo: false, svgoPrecision: null },
      analysis,
    });
    expect(effective.keyBackground).toBe(false);

    const svgPath = path.join(dir, "card.svg");
    const inkscape = await resolveInkscapeBinary(null);
    const traced = await traceToSvg({
      inkscapePath: inkscape,
      inputPath: source,
      outputPath: svgPath,
      trace: effective,
      timeoutMs: 60_000,
    });
    expect(traced.ok).toBe(true);
    const corner = (await sampleSvg(svgPath))(4, 4);
    expect(corner[3]).toBeGreaterThan(200);
    expect(corner[0]).toBeGreaterThan(200);
    expect(corner[1]).toBeGreaterThan(200);
    expect(corner[2]).toBeGreaterThan(200);
  }, 60_000);
});

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

async function sampleSvg(svgPath: string): Promise<(x: number, y: number) => Buffer> {
  const { readFile } = await import("node:fs/promises");
  const svg = await readFile(svgPath, "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const scaleX = raw.info.width / width;
  const scaleY = raw.info.height / height;
  return (x, y) => {
    const sampleX = Math.min(raw.info.width - 1, Math.round(x * scaleX));
    const sampleY = Math.min(raw.info.height - 1, Math.round(y * scaleY));
    const index = (sampleY * raw.info.width + sampleX) * 4;
    return raw.data.subarray(index, index + 4);
  };
}
