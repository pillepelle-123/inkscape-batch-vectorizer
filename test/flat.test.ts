import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import type { FlatColors } from "../src/config.ts";
import { analyzeFlat, dilateIntoOutline } from "../src/flat.ts";

const options: FlatColors = { mode: "auto", colorDistance: 12, maxColors: 12, dilate: 2 };
const tempDirs: string[] = [];
const doodlePath =
  "C:/Users/pille/Pictures/dein-freundebuch.de/01 STICKER/00 STICKER OHNE DESIGN/07 - Pastell Doodle Papeterie/Pastell-Doodle-Papeterie/Einzelassets/e_Notizfeld_Spirale_links.png";
const botanikPath =
  "C:/Users/pille/Pictures/dein-freundebuch.de/01 STICKER/00 STICKER OHNE DESIGN/06 - Boho-Hochzeit/Boho-Hochzeit/Einzelassets/b2_Botanik_Seitenornament_rechts.png";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("analyzeFlat", () => {
  it("erkennt ein Doodle mit Umriss und weist Kantenpixel einer Fläche zu", async () => {
    const size = 48;
    const pixels = Buffer.alloc(size * size * 4, 0);
    fillRect(pixels, size, 4, 4, 40, 40, 8, 8, 8);
    fillRect(pixels, size, 8, 8, 32, 32, 245, 245, 245);
    fillRect(pixels, size, 10, 12, 12, 24, 255, 176, 196);
    fillRect(pixels, size, 26, 12, 12, 24, 255, 230, 150);
    pixels[(6 * size + 4) * 4] = 140;
    pixels[(6 * size + 4) * 4 + 1] = 140;
    pixels[(6 * size + 4) * 4 + 2] = 140;
    pixels[(6 * size + 4) * 4 + 3] = 255;

    const result = await analyzeFlat(await png(pixels, size), options);
    expect(result.isFlat).toBe(true);
    expect(result.palette.length).toBe(4);
    const edge = result.labels[6 * size + 4] ?? -1;
    const edgeColor = result.palette[edge];
    expect(edgeColor).toBeDefined();
    const nearBlack = (edgeColor?.r ?? 255) < 40;
    const nearWhite = (edgeColor?.r ?? 0) > 220;
    expect(nearBlack || nearWhite).toBe(true);
  });

  it("lehnt einen Farbverlauf ab", async () => {
    const width = 80;
    const height = 16;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        pixels[index] = Math.round((x / (width - 1)) * 255);
        pixels[index + 1] = Math.round(((width - 1 - x) / (width - 1)) * 255);
        pixels[index + 2] = 40;
        pixels[index + 3] = 255;
      }
    }
    const result = await analyzeFlat(await png(pixels, width, height), options);
    expect(result.isFlat).toBe(false);
  });

  it("lehnt wasserfarbenartiges Rauschen ab", async () => {
    const size = 48;
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const wave = Math.round(70 * Math.sin(x / 2) * Math.cos(y / 3));
        const index = (y * size + x) * 4;
        pixels[index] = clamp(160 + wave);
        pixels[index + 1] = clamp(90 + wave / 2);
        pixels[index + 2] = clamp(40 - wave / 3);
        pixels[index + 3] = 255;
      }
    }
    const result = await analyzeFlat(await png(pixels, size), options);
    expect(result.isFlat).toBe(false);
  });

  it.skipIf(!existsSync(doodlePath) || !existsSync(botanikPath))(
    "erkennt das Notizfeld als Fläche und das Botanik-Aquarell nicht",
    async () => {
      const doodle = await analyzeFlat(doodlePath, options);
      const botanik = await analyzeFlat(botanikPath, options);
      expect(doodle.isFlat).toBe(true);
      expect(botanik.isFlat).toBe(false);
    },
    60_000,
  );
});

describe("dilateIntoOutline", () => {
  it("wächst nur in die Umrissfarbe", () => {
    const width = 7;
    const labels = new Int16Array([
      0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 0, 0, 0, 1, 1, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const grown = dilateIntoOutline(labels, width, 4, 2, 1, 2);
    expect(grown[1 * width + 3]).toBe(1);
    expect(grown[1 * width + 2]).toBe(1);
    expect(grown[1 * width + 1]).toBe(1);
    expect(grown[1 * width + 0]).toBe(0);
  });
});

function fillRect(
  pixels: Buffer,
  size: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  red: number,
  green: number,
  blue: number,
): void {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      const index = (y * size + x) * 4;
      pixels[index] = red;
      pixels[index + 1] = green;
      pixels[index + 2] = blue;
      pixels[index + 3] = 255;
    }
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

async function png(pixels: Buffer, width: number, height = width): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-flat-"));
  tempDirs.push(dir);
  const file = path.join(dir, "image.png");
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(file);
  return file;
}
