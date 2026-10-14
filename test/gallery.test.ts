import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GALLERY_FILE, isGalleryEnabled, renderGalleryPage, updateGallery, writeGallery } from "../src/gallery.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("isGalleryEnabled", () => {
  it("gilt nur für den Wert true", () => {
    expect(isGalleryEnabled({})).toBe(false);
    expect(isGalleryEnabled({ GALLERY: "false" })).toBe(false);
    expect(isGalleryEnabled({ GALLERY: "TRUE" })).toBe(false);
    expect(isGalleryEnabled({ GALLERY: "true" })).toBe(true);
  });
});

describe("renderGalleryPage", () => {
  it("escaped einen Dateinamen mit spitzer Klammer", () => {
    const html = renderGalleryPage("Ausgabe", ["a<b>.svg"]);
    expect(html).toContain(">a&lt;b&gt;</span>");
    expect(html).toContain('src="a%3Cb%3E.svg"');
    expect(html).not.toContain("a<b>");
  });
});

describe("writeGallery", () => {
  it("legt die Seite an, nimmt eine neue Datei auf und lässt eine gelöschte weg", async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, "nested"), { recursive: true });
    await writeFile(path.join(dir, "b.svg"), "<svg></svg>");
    await writeFile(path.join(dir, "a10.svg"), "<svg></svg>");
    await writeFile(path.join(dir, "a2.svg"), "<svg></svg>");
    await writeFile(path.join(dir, "nested", "hidden.svg"), "<svg></svg>");
    await writeFile(path.join(dir, "note.txt"), "text");

    expect(await writeGallery(dir)).toBe(3);
    const first = await readFile(path.join(dir, GALLERY_FILE), "utf8");
    expect(first).toContain("<dialog");
    expect(first).toContain("Schließen");
    expect(first.indexOf(">a2</span>")).toBeLessThan(first.indexOf(">a10</span>"));
    expect(first.indexOf(">a10</span>")).toBeLessThan(first.indexOf(">b</span>"));
    expect(first).not.toContain("hidden");

    await writeFile(path.join(dir, "c.svg"), "<svg></svg>");
    await rm(path.join(dir, "b.svg"));
    expect(await writeGallery(dir)).toBe(3);
    const second = await readFile(path.join(dir, GALLERY_FILE), "utf8");
    expect(second).toContain(">c</span>");
    expect(second).not.toContain(">b</span>");
  });

  it("schreibt einen Hinweis, wenn der Ordner keine SVGs enthält", async () => {
    const dir = await makeTempDir();
    expect(await writeGallery(dir)).toBe(0);
    const html = await readFile(path.join(dir, GALLERY_FILE), "utf8");
    expect(html).toContain("Dieser Ordner enthält keine SVG-Dateien.");
  });
});

describe("updateGallery", () => {
  it("legt ohne GALLERY=true keine Datei an", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "a.svg"), "<svg></svg>");
    expect(await updateGallery(dir, {})).toBeNull();
    await expect(readFile(path.join(dir, GALLERY_FILE), "utf8")).rejects.toThrow();
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-gallery-"));
  tempDirs.push(dir);
  return dir;
}
