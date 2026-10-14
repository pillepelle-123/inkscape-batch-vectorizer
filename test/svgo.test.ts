import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { optimizeSvgFile } from "../src/svgo.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("optimizeSvgFile", () => {
  it("kürzt Nachkommastellen und behält die viewBox", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-svgo-"));
    tempDirs.push(dir);
    const file = path.join(dir, "logo.svg");
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">
  <path id="path1" style="fill:#ff0000" d="M 1.123456,1.123456 L 8.987654,1.123456 L 8.987654,8.987654 Z"/>
</svg>`;
    await writeFile(file, source);

    await optimizeSvgFile(file, 1);

    const optimized = await readFile(file, "utf8");
    expect(optimized).toContain('viewBox="0 0 10 10"');
    expect(optimized).toContain("<path");
    expect(optimized.length).toBeLessThan(source.length);
  });
});
