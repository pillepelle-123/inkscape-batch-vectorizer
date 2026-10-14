import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BatchError, collectBatchFiles, commitOutput, resolveSingleFile, runBatch } from "../src/batch.ts";
import type { Config } from "../src/config.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function config(root: string, overrides: Partial<Config> = {}): Config {
  return {
    inputDir: path.join(root, "input"),
    outputDir: path.join(root, "output"),
    extensions: [".png", ".jpg", ".jpeg"],
    overwrite: true,
    concurrency: 2,
    timeoutSeconds: 120,
    inkscapePath: null,
    trace: {
      scans: 8,
      smooth: true,
      stack: true,
      removeBackground: false,
      speckles: 2,
      smoothCorners: 1,
      optimize: 0.2,
    },
    autoColors: { minColorDistance: 10, minColorShare: 0.005 },
    simplify: { level: "off", maxColors: null, medianSize: null, svgo: true, svgoPrecision: null },
    ...overrides,
  };
}

describe("collectBatchFiles", () => {
  it("nimmt nur Dateien der obersten Ebene mit passender Endung", async () => {
    const root = await makeTempDir();
    const input = path.join(root, "input");
    await mkdir(path.join(input, "nested"), { recursive: true });
    await writeFile(path.join(input, "b.PNG"), "");
    await writeFile(path.join(input, "a.jpg"), "");
    await writeFile(path.join(input, "note.txt"), "");
    await writeFile(path.join(input, "nested", "hidden.png"), "");

    const files = await collectBatchFiles(config(root));
    expect(files.map((file) => path.basename(file))).toEqual(["a.jpg", "b.PNG"]);
  });

  it("meldet einen fehlenden Input-Ordner", async () => {
    const root = await makeTempDir();
    await expect(collectBatchFiles(config(root))).rejects.toThrow(/Input-Ordner nicht gefunden/);
  });
});

describe("resolveSingleFile", () => {
  it("löst einen Dateinamen relativ zum Input-Ordner auf", async () => {
    const root = await makeTempDir();
    const input = path.join(root, "input");
    await mkdir(input, { recursive: true });
    const file = path.join(input, "logo.png");
    await writeFile(file, "");

    await expect(resolveSingleFile("logo.png", config(root))).resolves.toBe(file);
    await expect(resolveSingleFile(file, config(root))).resolves.toBe(file);
  });

  it("lehnt fehlende Dateien und fremde Endungen ab", async () => {
    const root = await makeTempDir();
    const input = path.join(root, "input");
    await mkdir(input, { recursive: true });
    await writeFile(path.join(input, "notes.txt"), "");

    await expect(resolveSingleFile("fehlt.png", config(root))).rejects.toBeInstanceOf(BatchError);
    await expect(resolveSingleFile("notes.txt", config(root))).rejects.toThrow(/nicht erlaubt/);
  });
});

describe("commitOutput", () => {
  it("ersetzt eine vorhandene Datei", async () => {
    const root = await makeTempDir();
    const source = path.join(root, "neu.svg");
    const target = path.join(root, "alt.svg");
    await writeFile(source, "<svg>neu</svg>");
    await writeFile(target, "<svg>alt</svg>");

    await commitOutput(source, target);

    const { readFile } = await import("node:fs/promises");
    await expect(readFile(target, "utf8")).resolves.toBe("<svg>neu</svg>");
    await expect(readFile(source, "utf8")).rejects.toThrow();
  });
});

describe("runBatch", () => {
  it("überspringt vorhandene SVGs, wenn overwrite aus ist", async () => {
    const root = await makeTempDir();
    const input = path.join(root, "input");
    const output = path.join(root, "output");
    await mkdir(input, { recursive: true });
    await mkdir(output, { recursive: true });
    await writeFile(path.join(input, "logo.png"), "");
    await writeFile(path.join(output, "logo.svg"), "<svg></svg>");

    const logs: string[] = [];
    const original = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    try {
      const outcomes = await runBatch(
        config(root, { overwrite: false }),
        [path.join(input, "logo.png")],
        "inkscape-wird-nicht-aufgerufen",
      );
      expect(outcomes).toEqual([{ status: "skipped", inputName: "logo.png" }]);
      expect(logs.join("\n")).toContain("SKIP");
      expect(logs.join("\n")).toContain("existiert bereits");
    } finally {
      console.log = original;
    }
  });

  it("bricht ab, wenn zwei Dateien dieselbe SVG erzeugen würden", async () => {
    const root = await makeTempDir();
    const input = path.join(root, "input");
    await mkdir(input, { recursive: true });
    await writeFile(path.join(input, "logo.png"), "");
    await writeFile(path.join(input, "logo.jpg"), "");

    await expect(
      runBatch(config(root), [path.join(input, "logo.png"), path.join(input, "logo.jpg")], "unused"),
    ).rejects.toThrow(/dieselbe SVG/);
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-batch-"));
  tempDirs.push(dir);
  return dir;
}
