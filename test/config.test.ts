import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resolveConfig, type ConfigFile } from "../src/config.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function validFile(overrides: Partial<ConfigFile> = {}): ConfigFile {
  return {
    inputDir: "./input",
    outputDir: "./output",
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

describe("resolveConfig", () => {
  it("löst relative Pfade gegen das Verzeichnis der Config auf", () => {
    const config = resolveConfig(validFile({ inkscapePath: "./bin/inkscape.com" }), "C:/projekte/vectorizer");
    expect(config.inputDir).toBe(path.resolve("C:/projekte/vectorizer", "input"));
    expect(config.outputDir).toBe(path.resolve("C:/projekte/vectorizer", "output"));
    expect(config.inkscapePath).toBe(path.resolve("C:/projekte/vectorizer", "bin/inkscape.com"));
    expect(config.extensions).toEqual([".png", ".jpg", ".jpeg"]);
  });

  it("normalisiert Dateiendungen auf Kleinbuchstaben", () => {
    const config = resolveConfig(validFile({ extensions: [".PNG", ".JpG"] }), "C:/tmp");
    expect(config.extensions).toEqual([".png", ".jpg"]);
  });
});

describe("loadConfig", () => {
  it("lädt eine gültige Datei und setzt Defaults", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "vectorizer.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        inputDir: "in",
        outputDir: "out",
        trace: validFile().trace,
      }),
    );

    const config = await loadConfig(configPath);
    expect(config.inputDir).toBe(path.join(dir, "in"));
    expect(config.outputDir).toBe(path.join(dir, "out"));
    expect(config.extensions).toEqual([".png", ".jpg", ".jpeg"]);
    expect(config.overwrite).toBe(true);
    expect(config.concurrency).toBe(2);
    expect(config.timeoutSeconds).toBe(120);
    expect(config.inkscapePath).toBeNull();
    expect(config.autoColors).toEqual({ minColorDistance: 10, minColorShare: 0.005 });
    expect(config.simplify).toEqual({
      level: "off",
      maxColors: null,
      medianSize: null,
      svgo: true,
      svgoPrecision: null,
    });
  });

  it("akzeptiert auto und ignoriert unbekannte Hinweis-Schlüssel", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "vectorizer.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        inputDir: "in",
        outputDir: "out",
        trace: {
          ...validFile().trace,
          scans: "auto",
          smooth: "auto",
          "--Hinweis 'speckles': opimaler Wert": "100 bis 500",
        },
      }),
    );

    const config = await loadConfig(configPath);
    expect(config.trace.scans).toBe("auto");
    expect(config.trace.smooth).toBe("auto");
    expect(config.trace.speckles).toBe(2);
  });

  it("meldet Werte außerhalb der erlaubten Bereiche auf Deutsch", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "vectorizer.config.json");
    const raw = validFile();
    raw.trace.scans = 1;
    raw.trace.speckles = 1001;
    raw.trace.smoothCorners = 1.35;
    raw.trace.optimize = 5.001;
    raw.concurrency = 0;
    await writeFile(configPath, JSON.stringify(raw));

    await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
    await expect(loadConfig(configPath)).rejects.toThrow(
      /trace\.scans: Ganzzahl von 2 bis 256 oder "auto" erwartet/,
    );
    await expect(loadConfig(configPath)).rejects.toThrow(/trace\.speckles: Ganzzahl von 0 bis 1000 erwartet/);
    await expect(loadConfig(configPath)).rejects.toThrow(/trace\.smoothCorners: Zahl von 0 bis 1\.34 erwartet/);
    await expect(loadConfig(configPath)).rejects.toThrow(/trace\.optimize: Zahl von 0 bis 5 erwartet/);
    await expect(loadConfig(configPath)).rejects.toThrow(/concurrency: Ganzzahl ab 1 erwartet/);
  });

  it("ignoriert eine UTF-8-BOM am Dateianfang", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "vectorizer.config.json");
    await writeFile(configPath, `\uFEFF${JSON.stringify({ inputDir: "in", outputDir: "out", trace: validFile().trace })}`);

    const config = await loadConfig(configPath);
    expect(config.inputDir).toBe(path.join(dir, "in"));
  });

  it("lehnt eine fehlende Datei und ungültiges JSON ab", async () => {
    const dir = await makeTempDir();
    await expect(loadConfig(path.join(dir, "fehlt.json"))).rejects.toThrow(/nicht gefunden/);

    const broken = path.join(dir, "broken.json");
    await writeFile(broken, "{");
    await expect(loadConfig(broken)).rejects.toThrow(/kein gültiges JSON/);
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vectorizer-config-"));
  tempDirs.push(dir);
  return dir;
}
