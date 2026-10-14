import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeImage } from "../src/analyze.ts";

const tempDirs: string[] = [];
const options = { minColorDistance: 10, minColorShare: 0.005 };

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("analyzeImage", () => {
  it("zählt drei klar getrennte Farben", async () => {
    const file = await writePng("three.png", paint((x) => (x < 22 ? [220, 20, 20] : x < 43 ? [20, 180, 40] : [20, 40, 220])));
    const result = await analyzeImage(file, options);
    expect(result.colors).toBe(3);
    expect(result.palette).toHaveLength(3);
    expect(result.hasTransparency).toBe(false);
    expect(result.smooth).toBe(false);
  });

  it("legt sehr ähnliche Töne zusammen", async () => {
    const file = await writePng(
      "similar.png",
      paint((x) => (x < 32 ? [200, 0, 0] : x < 48 ? [208, 4, 4] : [0, 0, 220])),
    );
    const result = await analyzeImage(file, options);
    expect(result.colors).toBe(2);
  });

  it("ignoriert einen transparenten Hintergrund", async () => {
    const file = await writePng(
      "alpha.png",
      paint((x, y) => (x >= 16 && x < 48 && y >= 16 && y < 48 ? [220, 30, 30, 255] : [0, 0, 0, 0])),
    );
    const result = await analyzeImage(file, options);
    expect(result.colors).toBe(1);
    expect(result.hasTransparency).toBe(true);
  });

  it("meldet Ausreißer bei seltenen Farben und glättet JPEG", async () => {
    const clean = await analyzeImage(
      await writePng("clean.png", paint(() => [180, 20, 20])),
      options,
    );
    const noisy = await analyzeImage(await writePng("noisy.png", noisyRed()), options);
    expect(noisy.outlierShare).toBeGreaterThan(clean.outlierShare);
    expect(noisy.outlierShare).toBeGreaterThan(0.01);

    const jpeg = await writeJpeg("flat.jpg", paint(() => [180, 20, 20]));
    const jpegResult = await analyzeImage(jpeg, options);
    expect(jpegResult.smooth).toBe(true);
  });
});

function paint(pixel: (x: number, y: number) => number[]): Buffer {
  const width = 64;
  const height = 64;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixel(x, y);
      const index = (y * width + x) * 4;
      data[index] = r ?? 0;
      data[index + 1] = g ?? 0;
      data[index + 2] = b ?? 0;
      data[index + 3] = a ?? 255;
    }
  }
  return data;
}

function noisyRed(): Buffer {
  const data = paint(() => [180, 20, 20]);
  const rare = [
    [0, 0, 255],
    [0, 255, 0],
    [255, 255, 0],
    [0, 255, 255],
    [255, 0, 255],
    [0, 80, 255],
    [80, 255, 0],
    [255, 160, 0],
    [0, 180, 180],
    [160, 0, 255],
  ];
  for (let color = 0; color < rare.length; color += 1) {
    for (let pixel = 0; pixel < 8; pixel += 1) {
      const offset = (color * 8 + pixel) * 4;
      data[offset] = rare[color]?.[0] ?? 0;
      data[offset + 1] = rare[color]?.[1] ?? 0;
      data[offset + 2] = rare[color]?.[2] ?? 0;
      data[offset + 3] = 255;
    }
  }
  return data;
}

async function writePng(name: string, data: Buffer): Promise<string> {
  return writeImage(name, data, "png");
}

async function writeJpeg(name: string, data: Buffer): Promise<string> {
  return writeImage(name, data, "jpeg");
}

async function writeImage(name: string, data: Buffer, format: "png" | "jpeg"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-analyze-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  const image = sharp(data, { raw: { width: 64, height: 64, channels: 4 } });
  if (format === "jpeg") {
    await image.jpeg().toFile(file);
  } else {
    await image.png().toFile(file);
  }
  return file;
}
