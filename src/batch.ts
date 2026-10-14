import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { styleText } from "node:util";
import { analyzeImage } from "./analyze.js";
import { pickKeyColor, removeKeyColorPlugin, writeKeyedPng } from "./background.js";
import type { Config } from "./config.js";
import { traceToSvg } from "./inkscape.js";
import { writeMedianPng } from "./preprocess.js";
import { resolveTrace } from "./simplify.js";
import { optimizeSvgFile } from "./svgo.js";

export type FileOutcome =
  | {
      status: "ok";
      inputName: string;
      outputName: string;
      seconds: number;
      scans: number;
      smooth: boolean;
      bytes: number;
      transparent: boolean;
      stackSuppressed: boolean;
    }
  | { status: "skipped"; inputName: string }
  | { status: "error"; inputName: string; message: string; seconds: number };

export class BatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchError";
  }
}

export function outputPathFor(inputPath: string, outputDir: string): string {
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(outputDir, `${base}.svg`);
}

export async function collectBatchFiles(config: Config): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(config.inputDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BatchError(`Input-Ordner nicht gefunden: ${config.inputDir}`);
    }
    throw new BatchError(`Input-Ordner konnte nicht gelesen werden: ${config.inputDir}`);
  }

  const extensions = new Set(config.extensions);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => extensions.has(path.extname(name).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, "de"))
    .map((name) => path.join(config.inputDir, name));
}

export async function resolveSingleFile(fileArg: string, config: Config): Promise<string> {
  const resolved = path.isAbsolute(fileArg) ? path.resolve(fileArg) : path.resolve(config.inputDir, fileArg);

  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BatchError(`Datei nicht gefunden: ${resolved}`);
    }
    throw new BatchError(`Datei konnte nicht gelesen werden: ${resolved}`);
  }

  if (!info.isFile()) {
    throw new BatchError(`Kein Dateipfad: ${resolved}`);
  }

  const extension = path.extname(resolved).toLowerCase();
  if (!config.extensions.includes(extension)) {
    throw new BatchError(
      `Dateiendung ${extension || "(keine)"} ist nicht erlaubt. Erlaubt: ${config.extensions.join(", ")}`,
    );
  }

  return resolved;
}

export async function runBatch(config: Config, files: string[], inkscapePath: string): Promise<FileOutcome[]> {
  await mkdir(config.outputDir, { recursive: true });
  assertUniqueOutputs(files, config.outputDir);

  const total = files.length;
  const outcomes: FileOutcome[] = new Array(total);
  let completed = 0;

  await runPool(files, config.concurrency, async (inputPath, index) => {
    const outcome = await processOne(config, inputPath, inkscapePath);
    outcomes[index] = outcome;
    completed += 1;
    printProgress(completed, total, outcome);
  });

  return outcomes;
}

function assertUniqueOutputs(files: string[], outputDir: string): void {
  const seen = new Map<string, string>();
  for (const file of files) {
    const output = outputPathFor(file, outputDir).toLowerCase();
    const previous = seen.get(output);
    if (previous) {
      throw new BatchError(
        `Mehrere Eingabedateien würden dieselbe SVG erzeugen: ${path.basename(previous)} und ${path.basename(file)}`,
      );
    }
    seen.set(output, file);
  }
}

async function processOne(config: Config, inputPath: string, inkscapePath: string): Promise<FileOutcome> {
  const inputName = path.basename(inputPath);
  const outputPath = outputPathFor(inputPath, config.outputDir);

  if (!config.overwrite) {
    try {
      await stat(outputPath);
      return { status: "skipped", inputName };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return {
          status: "error",
          inputName,
          message: "Ausgabedatei konnte nicht geprüft werden",
          seconds: 0,
        };
      }
    }
  }

  const temporaryPath = path.join(
    config.outputDir,
    `${path.basename(outputPath, ".svg")}.${process.pid}.partial.svg`,
  );
  const started = performance.now();
  let preprocessed: string | null = null;
  try {
    const needsAnalysis =
      config.trace.scans === "auto" || config.trace.smooth === "auto" || config.trace.removeBackground;
    const analysis = needsAnalysis ? await analyzeImage(inputPath, config.autoColors) : null;
    const effective = resolveTrace({ trace: config.trace, simplify: config.simplify, analysis });
    const keyColor = effective.keyBackground ? pickKeyColor(analysis?.palette ?? []) : null;
    let traceInput = inputPath;
    if (keyColor) {
      preprocessed = await writeKeyedPng(inputPath, keyColor, effective.medianSize);
      traceInput = preprocessed;
    } else if (effective.medianSize > 0) {
      preprocessed = await writeMedianPng(inputPath, effective.medianSize);
      traceInput = preprocessed;
    }

    const result = await traceToSvg({
      inkscapePath,
      inputPath: traceInput,
      outputPath: temporaryPath,
      trace: effective,
      timeoutMs: config.timeoutSeconds * 1000,
    });
    const seconds = (performance.now() - started) / 1000;

    if (!result.ok) {
      await rm(temporaryPath, { force: true });
      return { status: "error", inputName, message: result.message, seconds };
    }

    const keyPlugin = keyColor ? removeKeyColorPlugin(keyColor) : null;
    if (effective.svgo || keyPlugin) {
      await optimizeSvgFile(temporaryPath, effective.svgoPrecision, {
        compress: effective.svgo,
        plugins: keyPlugin ? [keyPlugin] : [],
      });
      if (keyPlugin && keyPlugin.removedPaths() === 0) {
        await rm(temporaryPath, { force: true });
        return {
          status: "error",
          inputName,
          message: "Transparenter Hintergrund nicht gefunden",
          seconds,
        };
      }
      const svg = await readFile(temporaryPath, "utf8");
      if (!svg.includes("<path")) {
        await rm(temporaryPath, { force: true });
        return {
          status: "error",
          inputName,
          message: "SVG enthält nach der Optimierung keine Vektorpfade",
          seconds,
        };
      }
    }

    const bytes = (await stat(temporaryPath)).size;
    await commitOutput(temporaryPath, outputPath);
    return {
      status: "ok",
      inputName,
      outputName: path.basename(outputPath),
      seconds,
      scans: effective.scans,
      smooth: effective.smooth,
      bytes,
      transparent: effective.keyBackground,
      stackSuppressed: effective.stackSuppressed,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", inputName, message, seconds: (performance.now() - started) / 1000 };
  } finally {
    if (preprocessed) {
      await rm(preprocessed, { force: true });
    }
  }
}

export async function commitOutput(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") {
      throw error;
    }
    await rm(to, { force: true });
    await rename(from, to);
  }
}

function printProgress(done: number, total: number, outcome: FileOutcome): void {
  const width = String(total).length;
  const counter = `[${String(done).padStart(width)}/${total}]`;

  if (outcome.status === "ok") {
    const status = styleText("green", "OK".padEnd(6));
    const details = [
      `${outcome.seconds.toFixed(1)} s`,
      `scans=${outcome.scans}`,
      `smooth=${outcome.smooth ? "ja" : "nein"}`,
    ];
    if (outcome.transparent) {
      details.push("transparent");
    }
    if (outcome.stackSuppressed) {
      details.push("stack=aus (Transparenz)");
    }
    details.push(formatBytes(outcome.bytes));
    console.log(`${counter} ${status} ${outcome.inputName} -> ${outcome.outputName} (${details.join(", ")})`);
    return;
  }

  if (outcome.status === "skipped") {
    const status = styleText("yellow", "SKIP".padEnd(6));
    console.log(`${counter} ${status} ${outcome.inputName} (existiert bereits)`);
    return;
  }

  const status = styleText("red", "FEHLER".padEnd(6));
  console.log(`${counter} ${status} ${outcome.inputName}: ${outcome.message}`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / 1024;
  const rounded = kilobytes >= 10 ? Math.round(kilobytes) : Math.round(kilobytes * 10) / 10;
  return `${rounded} KB`;
}

export function printSummary(outcomes: FileOutcome[], elapsedSeconds: number): void {
  const ok = outcomes.filter((outcome) => outcome.status === "ok").length;
  const skipped = outcomes.filter((outcome) => outcome.status === "skipped").length;
  const failed = outcomes.filter((outcome) => outcome.status === "error").length;
  console.log("");
  console.log(
    `Zusammenfassung: ${ok} OK, ${skipped} übersprungen, ${failed} Fehler (${elapsedSeconds.toFixed(1)} s)`,
  );
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index] as T, index);
    }
  });
  await Promise.all(workers);
}
