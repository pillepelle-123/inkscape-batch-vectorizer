import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeDetail } from "../src/detail.ts";

const maxSpeckles = 100;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("analyzeDetail", () => {
  it("hält speckles unter der Glanzpunktfläche und wählt bei Textur Median 3", async () => {
    const size = 96;
    const pixels = Buffer.alloc(size * size * 4, 0);
    fillBody(pixels, size, (x, y) => 150 + ((x * 13 + y * 7) % 11) - 5);
    fillDisk(pixels, size, 48, 48, 16, 8, 8, 8);
    fillDisk(pixels, size, 48, 48, 3, 250, 250, 250);
    const result = await analyzeDetail(await png(pixels, size), { maxSpeckles });
    expect(result.highlights).toBeGreaterThan(0);
    expect(result.smallestHighlight).not.toBeNull();
    expect(result.speckles).toBeLessThan(result.smallestHighlight ?? 0);
    expect(result.medianSize).toBe(3);
  });

  it("nimmt die Obergrenze, wenn es keine Glanzpunkte gibt", async () => {
    const size = 40;
    const pixels = Buffer.alloc(size * size * 4);
    fillRect(pixels, size, 0, 0, size, size, 140, 140, 140);
    const result = await analyzeDetail(await png(pixels, size), { maxSpeckles });
    expect(result.highlights).toBe(0);
    expect(result.speckles).toBe(maxSpeckles);
    expect(result.smallestHighlight).toBeNull();
  });

  it("lässt flache Grafiken ohne Median", async () => {
    const size = 48;
    const pixels = Buffer.alloc(size * size * 4, 0);
    fillRect(pixels, size, 8, 8, 32, 32, 190, 40, 40);
    const result = await analyzeDetail(await png(pixels, size), { maxSpeckles });
    expect(result.medianSize).toBe(0);
    expect(result.noise).toBeLessThan(1);
  });

  it("verhindert Median 5, wenn der Glanzpunkt ihn nicht übersteht", async () => {
    const size = 80;
    const pixels = Buffer.alloc(size * size * 4, 0);
    fillBody(pixels, size, (x, y) => (x % 4 === 0 && y % 4 === 0 ? 230 : 90));
    fillDisk(pixels, size, 40, 40, 14, 6, 6, 6);
    fillDisk(pixels, size, 40, 40, 2, 250, 250, 250);
    const result = await analyzeDetail(await png(pixels, size), { maxSpeckles });
    expect(result.highlights).toBeGreaterThan(0);
    expect(result.noise).toBeGreaterThanOrEqual(6);
    expect(result.medianSize).toBeLessThan(5);
  });

  it("zählt einen dünnen hellen Strich zwischen Konturen nicht als Glanzpunkt", async () => {
    const size = 40;
    const pixels = Buffer.alloc(size * size * 4);
    fillRect(pixels, size, 0, 0, size, size, 160, 120, 40);
    fillRect(pixels, size, 8, 4, 10, 32, 5, 5, 5);
    fillRect(pixels, size, 19, 4, 10, 32, 5, 5, 5);
    fillRect(pixels, size, 18, 4, 1, 32, 250, 250, 250);
    const result = await analyzeDetail(await png(pixels, size), { maxSpeckles });
    expect(result.highlights).toBe(0);
  });
});

function fillBody(pixels: Buffer, size: number, color: (x: number, y: number) => number): void {
  for (let y = 8; y < size - 8; y += 1) {
    for (let x = 8; x < size - 8; x += 1) {
      const value = color(x, y);
      set(pixels, size, x, y, value, value - 20, 40);
    }
  }
}

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
      set(pixels, size, x, y, red, green, blue);
    }
  }
}

function fillDisk(
  pixels: Buffer,
  size: number,
  cx: number,
  cy: number,
  radius: number,
  red: number,
  green: number,
  blue: number,
): void {
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        set(pixels, size, x, y, red, green, blue);
      }
    }
  }
}

function set(pixels: Buffer, size: number, x: number, y: number, red: number, green: number, blue: number): void {
  const index = (y * size + x) * 4;
  pixels[index] = clamp(red);
  pixels[index + 1] = clamp(green);
  pixels[index + 2] = clamp(blue);
  pixels[index + 3] = 255;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}

async function png(pixels: Buffer, size: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-detail-"));
  tempDirs.push(dir);
  const file = path.join(dir, "image.png");
  await sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).png().toFile(file);
  return file;
}
