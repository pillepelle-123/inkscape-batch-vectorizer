import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { styleText } from "node:util";
import { analyzeImage } from "./analyze.js";
import { analyzeDetail } from "./detail.js";
import { applySilhouetteClipPlugin, writeAlphaMaskPng, writeEdgeFilledPng } from "./background.js";
import { analyzeFlat } from "./flat.js";
import { traceFlat } from "./flatTrace.js";
import type { Config } from "./config.js";
import { readViewBox, traceSilhouette, traceToSvg } from "./inkscape.js";
import { writeMedianPng } from "./preprocess.js";
import { resolveTrace } from "./simplify.js";
import { optimizeSvgFile } from "./svgo.js";
import type { PluginConfig } from "svgo";

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
      speckles: number;
      specklesAuto: boolean;
      medianSize: number;
      medianAuto: boolean;
      flatColors: number | null;
    }
  | { status: "skipped"; inputName: string }
  | { status: "error"; inputName: string; message: string; seconds: number };

export class BatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchError";
  }
}

/** Der Lauf wurde abgebrochen, weil das Log eines Bildes nicht geschrieben werden konnte. */
export class BatchStoppedError extends Error {
  readonly outcomes: FileOutcome[];

  constructor(cause: unknown, outcomes: FileOutcome[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BatchStoppedError";
    this.outcomes = outcomes;
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

export async function runBatch(
  config: Config,
  files: string[],
  inkscapePath: string,
  onOutcome?: (outcome: FileOutcome, index: number) => Promise<void>,
): Promise<FileOutcome[]> {
  await mkdir(config.outputDir, { recursive: true });
  assertUniqueOutputs(files, config.outputDir);

  const total = files.length;
  const outcomes: Array<FileOutcome | undefined> = new Array(total);
  let completed = 0;

  try {
    await runPool(files, config.concurrency, async (inputPath, index) => {
      const outcome = await processOne(config, inputPath, inkscapePath);
      outcomes[index] = outcome;
      completed += 1;
      printProgress(completed, total, outcome);
      await onOutcome?.(outcome, index);
    });
  } catch (error) {
    throw new BatchStoppedError(error, outcomes.filter((outcome): outcome is FileOutcome => outcome !== undefined));
  }

  return outcomes.filter((outcome): outcome is FileOutcome => outcome !== undefined);
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
  const temporaryFiles: string[] = [];
  try {
    const flat =
      config.flatColors.mode === "off" ? null : await analyzeFlat(inputPath, config.flatColors);
    const useFlat = flat !== null && (config.flatColors.mode === "flat" || flat.isFlat);
    const needsAnalysis =
      config.trace.scans === "auto" ||
      config.trace.smooth === "auto" ||
      (!useFlat && config.trace.removeBackground);
    const needsDetail =
      config.trace.speckles === "auto" || (!useFlat && config.simplify.medianSize === "auto");
    const analysis = needsAnalysis ? await analyzeImage(inputPath, config.autoColors) : null;
    const detail = needsDetail
      ? await analyzeDetail(inputPath, config.autoDetail)
      : useFlat && config.simplify.medianSize === "auto"
        ? { speckles: 0, medianSize: 0, highlights: 0, smallestHighlight: null, noise: 0 }
        : null;
    const effective = resolveTrace({ trace: config.trace, simplify: config.simplify, analysis, detail });
    if (useFlat && flat) {
      const traced = await traceFlat({
        analysis: flat,
        inkscapePath,
        outputPath: temporaryPath,
        speckles: effective.speckles,
        smoothCorners: effective.smoothCorners,
        optimize: effective.optimize,
        timeoutMs: config.timeoutSeconds * 1000,
        dilate: config.flatColors.dilate,
        svgo: effective.svgo,
        svgoPrecision: effective.svgoPrecision,
        clip: flat.hasTransparency && config.trace.removeBackground,
      });
      const seconds = (performance.now() - started) / 1000;
      if (!traced.ok) {
        await rm(temporaryPath, { force: true });
        return { status: "error", inputName, message: traced.message, seconds };
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
      const bytes = (await stat(temporaryPath)).size;
      await commitOutput(temporaryPath, outputPath);
      return {
        status: "ok",
        inputName,
        outputName: path.basename(outputPath),
        seconds,
        scans: traced.colors,
        smooth: effective.smooth,
        bytes,
        transparent: flat.hasTransparency && config.trace.removeBackground,
        speckles: effective.speckles,
        specklesAuto: effective.specklesAuto,
        medianSize: effective.medianSize,
        medianAuto: false,
        flatColors: traced.colors,
      };
    }
    let traceInput = inputPath;
    if (effective.clipBackground) {
      traceInput = await writeEdgeFilledPng(inputPath, effective.medianSize);
      temporaryFiles.push(traceInput);
    } else if (effective.medianSize > 0) {
      traceInput = await writeMedianPng(inputPath, effective.medianSize);
      temporaryFiles.push(traceInput);
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

    const plugins: PluginConfig[] = [];
    if (effective.clipBackground) {
      const maskPath = await writeAlphaMaskPng(inputPath);
      temporaryFiles.push(maskPath);
      const silhouette = await traceSilhouette({
        inkscapePath,
        inputPath: maskPath,
        speckles: effective.speckles,
        smoothCorners: effective.smoothCorners,
        optimize: effective.optimize,
        timeoutMs: config.timeoutSeconds * 1000,
      });
      if (!silhouette.ok) {
        await rm(temporaryPath, { force: true });
        return { status: "error", inputName, message: silhouette.message, seconds };
      }
      const colorSvg = await readFile(temporaryPath, "utf8");
      if (readViewBox(colorSvg) !== silhouette.viewBox) {
        await rm(temporaryPath, { force: true });
        return {
          status: "error",
          inputName,
          message: "Die viewBox der Silhouette stimmt nicht mit der Farbzeichnung überein",
          seconds,
        };
      }
      plugins.push(applySilhouetteClipPlugin(silhouette.d));
    }

    if (effective.svgo || plugins.length > 0) {
      await optimizeSvgFile(temporaryPath, effective.svgoPrecision, {
        compress: effective.svgo,
        plugins,
      });
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
      transparent: effective.clipBackground,
      speckles: effective.speckles,
      specklesAuto: effective.specklesAuto,
      medianSize: effective.medianSize,
      medianAuto: effective.medianAuto,
      flatColors: null,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", inputName, message, seconds: (performance.now() - started) / 1000 };
  } finally {
    await Promise.all(temporaryFiles.map((file) => rm(file, { force: true })));
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
      outcome.flatColors !== null ? `flach (${outcome.flatColors} Farben)` : `scans=${outcome.scans}`,
      `smooth=${outcome.smooth ? "ja" : "nein"}`,
    ];
    if (outcome.transparent) {
      details.push("transparent");
    }
    if (outcome.specklesAuto) {
      details.push(`speckles=${outcome.speckles} (auto)`);
    }
    if (outcome.medianAuto) {
      details.push(`median=${outcome.medianSize} (auto)`);
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

export function printSummary(outcomes: FileOutcome[], elapsedSeconds: number, batchId?: number): void {
  const ok = outcomes.filter((outcome) => outcome.status === "ok").length;
  const skipped = outcomes.filter((outcome) => outcome.status === "skipped").length;
  const failed = outcomes.filter((outcome) => outcome.status === "error").length;
  const batch = batchId === undefined ? "" : `Batch ${batchId}, `;
  console.log("");
  console.log(
    `Zusammenfassung: ${batch}${ok} OK, ${skipped} übersprungen, ${failed} Fehler (${elapsedSeconds.toFixed(1)} s)`,
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
  let stopError: unknown = null;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (stopError === null && next < items.length) {
      const index = next;
      next += 1;
      try {
        await worker(items[index] as T, index);
      } catch (error) {
        stopError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (stopError) {
    throw stopError;
  }
}
