import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { optimize } from "svgo";
import { afterEach, describe, expect, it } from "vitest";
import { pickKeyColor, removeKeyColorPlugin, writeKeyedPng } from "../src/background.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pickKeyColor", () => {
  it("weicht aus, wenn Magenta in der Palette vorkommt", () => {
    const color = pickKeyColor([
      { r: 255, g: 0, b: 255 },
      { r: 20, g: 20, b: 20 },
    ]);
    expect(color).not.toEqual({ r: 255, g: 0, b: 255 });
  });

  it("wählt Magenta, wenn die Palette leer ist", () => {
    expect(pickKeyColor([])).toEqual({ r: 255, g: 0, b: 255 });
  });
});

describe("writeKeyedPng", () => {
  it("setzt transparente Pixel auf die Schlüsselfarbe und macht den Rest deckend", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-key-"));
    tempDirs.push(dir);
    const source = path.join(dir, "source.png");
    const data = Buffer.from([
      10, 20, 30, 0,
      40, 50, 60, 100,
      70, 80, 90, 200,
      1, 2, 3, 255,
    ]);
    await sharp(data, { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(source);

    const keyed = await writeKeyedPng(source, { r: 255, g: 0, b: 255 }, 0);
    const raw = await sharp(keyed).ensureAlpha().raw().toBuffer();
    const { rm } = await import("node:fs/promises");
    await rm(keyed, { force: true });
    expect([...raw.subarray(0, 4)]).toEqual([255, 0, 255, 255]);
    expect([...raw.subarray(4, 8)]).toEqual([255, 0, 255, 255]);
    expect([...raw.subarray(8, 12)]).toEqual([70, 80, 90, 255]);
    expect([...raw.subarray(12, 16)]).toEqual([1, 2, 3, 255]);
  });
});

describe("removeKeyColorPlugin", () => {
  it("entfernt nur Pfade der Schlüsselfarbe", () => {
    const plugin = removeKeyColorPlugin({ r: 255, g: 0, b: 255 });
    const source = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <path style="fill:#fe00fe" d="M0 0h10v10z"/>
  <path style="fill:#ffffff" d="M2 2h2v2z"/>
  <path fill="#111111" d="M4 4h2v2z"/>
</svg>`;
    const result = optimize(source, { plugins: [plugin] });
    expect(plugin.removedPaths()).toBe(1);
    expect(result.data).not.toMatch(/fe00fe/i);
    expect(result.data).toMatch(/ffffff/i);
    expect(result.data).toMatch(/111111/i);
    expect(result.data).toContain("viewBox");
  });
});
