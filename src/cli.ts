#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  BatchError,
  BatchStoppedError,
  collectBatchFiles,
  printSummary,
  resolveSingleFile,
  runBatch,
  type FileOutcome,
} from "./batch.js";
import { ConfigError, loadConfig, simplifyLevels, type SimplifyLevel } from "./config.js";
import { LogError, openBatchLog, type BatchLog } from "./db.js";
import { GALLERY_FILE, updateGallery } from "./gallery.js";
import { InkscapeError, resolveInkscapeBinary } from "./inkscape.js";

const HELP = `Verwendung:
  inkscape-vectorize [datei] [--config <pfad>] [--simplify <stufe>]

Ohne Dateiname werden alle passenden Dateien im Input-Ordner verarbeitet.
Mit einem Dateinamen wird nur diese Datei verarbeitet (relativ zum Input-Ordner oder absolut).

Optionen:
  -c, --config <pfad>       Konfigurationsdatei (Standard: vectorizer.config.json)
  -s, --simplify <stufe>    off, light, medium oder strong (überschreibt die Config)
  -h, --help                Diese Hilfe anzeigen
`;

export async function main(argv: string[]): Promise<number> {
  let values: { config?: string; help?: boolean; simplify?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        config: { type: "string", short: "c" },
        simplify: { type: "string", short: "s" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error(HELP);
    return 1;
  }

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  if (positionals.length > 1) {
    console.error("Es ist höchstens ein Dateiname erlaubt.");
    console.error(HELP);
    return 1;
  }

  const configPath = path.resolve(values.config ?? "vectorizer.config.json");
  let galleryDir: string | null = null;

  try {
    const config = await loadConfig(configPath);
    if (values.simplify !== undefined) {
      if (!isSimplifyLevel(values.simplify)) {
        console.error(`Unbekannte Stufe "${values.simplify}". Erlaubt: ${simplifyLevels.join(", ")}.`);
        return 1;
      }
      config.simplify = { ...config.simplify, level: values.simplify };
    }
    galleryDir = config.outputDir;
    const inkscapePath = await resolveInkscapeBinary(config.inkscapePath);
    const files =
      positionals.length === 1
        ? [await resolveSingleFile(positionals[0] as string, config)]
        : await collectBatchFiles(config);
    const rawConfig = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, "")) as unknown;
    const log = await openBatchLog({
      inputDir: config.inputDir,
      outputDir: config.outputDir,
      configPath,
      config: rawConfig,
      simplifyOverride: values.simplify ?? null,
      singleFile: positionals[0] ?? null,
      fileCount: files.length,
    });

    try {
      if (files.length === 0) {
        await log.finish({
          durationSeconds: 0,
          outcomes: [],
          status: "completed",
          exitCode: 0,
          errorMessage: null,
        });
        console.log(`Keine passenden Dateien in ${config.inputDir}`);
        printSummary([], 0, log.batchId);
        return 0;
      }

      const started = performance.now();
      try {
        const outcomes = await runBatch(config, files, inkscapePath, async (outcome, index) => {
          await log.insertAsset(outcome, index + 1);
        });
        const elapsed = (performance.now() - started) / 1000;
        const exitCode = outcomes.some((outcome) => outcome.status === "error") ? 1 : 0;
        await log.finish({
          durationSeconds: elapsed,
          outcomes,
          status: "completed",
          exitCode,
          errorMessage: null,
        });
        printSummary(outcomes, elapsed, log.batchId);
        return exitCode;
      } catch (error) {
        if (!(error instanceof BatchStoppedError)) {
          throw error;
        }
        await recordAbort(log, error.outcomes, (performance.now() - started) / 1000, error.message);
        printSummary(error.outcomes, (performance.now() - started) / 1000, log.batchId);
        console.error(`Log konnte nicht geschrieben werden: ${error.message}`);
        return 1;
      }
    } finally {
      await log.close();
    }
  } catch (error) {
    if (error instanceof LogError) {
      console.error(`Log konnte nicht geschrieben werden: ${error.message}`);
      return 1;
    }
    if (error instanceof ConfigError || error instanceof BatchError || error instanceof InkscapeError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    if (galleryDir) {
      await publishGallery(galleryDir);
    }
  }
}

async function publishGallery(outputDir: string): Promise<void> {
  try {
    const count = await updateGallery(outputDir);
    if (count !== null) {
      console.log(`Galerie: ${count} Bilder in ${GALLERY_FILE}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Galerie konnte nicht geschrieben werden: ${message}`);
  }
}

async function recordAbort(
  log: BatchLog,
  outcomes: FileOutcome[],
  durationSeconds: number,
  message: string,
): Promise<void> {
  try {
    await log.finish({
      durationSeconds,
      outcomes,
      status: "aborted",
      exitCode: 1,
      errorMessage: message,
    });
  } catch {
    // Die Verbindung ist schon ausgefallen. Der Lauf endet trotzdem mit Code 1.
  }
}

function isSimplifyLevel(value: string): value is SimplifyLevel {
  return (simplifyLevels as readonly string[]).includes(value);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const entryUrl = pathToFileURL(path.resolve(entry)).href;
  if (process.platform === "win32") {
    return import.meta.url.toLowerCase() === entryUrl.toLowerCase();
  }
  return import.meta.url === entryUrl;
}

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
