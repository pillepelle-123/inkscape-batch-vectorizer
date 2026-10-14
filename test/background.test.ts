import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { optimize } from "svgo";
import { afterEach, describe, expect, it } from "vitest";
import { applySilhouetteClipPlugin, findEdgeColor, writeAlphaMaskPng, writeEdgeFilledPng } from "../src/background.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("findEdgeColor", () => {
  it("nimmt die Farbe des Rands, nicht die der Innenfläche", () => {
    const width = 8;
    const height = 8;
    const data = Buffer.alloc(width * height * 4, 0);
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1) {
        const index = (y * width + x) * 4;
        const edge = x === 2 || x === 5 || y === 2 || y === 5;
        data[index] = edge ? 0 : 220;
        data[index + 1] = edge ? 0 : 30;
        data[index + 2] = edge ? 0 : 30;
        data[index + 3] = 255;
      }
    }
    const color = findEdgeColor(data, width, height);
    expect(color.r).toBeLessThan(20);
    expect(color.g).toBeLessThan(20);
    expect(color.b).toBeLessThan(20);
  });
});

describe("writeEdgeFilledPng", () => {
  it("macht das Bild vollständig deckend", async () => {
    const source = await writePng([0, 0, 0, 0, 10, 20, 30, 255]);
    const filled = await writeEdgeFilledPng(source, 0);
    const raw = await sharp(filled).ensureAlpha().raw().toBuffer();
    expect(raw[3]).toBe(255);
    expect(raw[7]).toBe(255);
    expect([...raw.subarray(4, 7)]).toEqual([10, 20, 30]);
  });
});

describe("writeAlphaMaskPng", () => {
  it("zeichnet deckende Pixel schwarz und transparente weiß", async () => {
    const source = await writePng([0, 0, 0, 0, 10, 20, 30, 255]);
    const mask = await writeAlphaMaskPng(source);
    const raw = await sharp(mask).ensureAlpha().raw().toBuffer();
    expect([...raw.subarray(0, 3)]).toEqual([255, 255, 255]);
    expect([...raw.subarray(4, 7)]).toEqual([0, 0, 0]);
  });
});

describe("applySilhouetteClipPlugin", () => {
  it("legt einen clipPath um den Inhalt und behält die viewBox", () => {
    const source = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <path style="fill:#ff0000" d="M0 0h10v10z"/>
</svg>`;
    const result = optimize(source, { plugins: [applySilhouetteClipPlugin("M1 1h8v8z")] });
    expect(result.data).toContain('id="vectorizer-silhouette"');
    expect(result.data).toContain("clip-path");
    expect(result.data).toContain("M1 1h8v8z");
    expect(result.data).toContain('viewBox="0 0 10 10"');
    expect(result.data).toContain("ff0000");
  });
});

async function writePng(pixels: number[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-bg-"));
  tempDirs.push(dir);
  const file = path.join(dir, "image.png");
  await sharp(Buffer.from(pixels), { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(file);
  return file;
}
