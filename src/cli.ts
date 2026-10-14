#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { BatchError, collectBatchFiles, printSummary, resolveSingleFile, runBatch } from "./batch.js";
import { ConfigError, loadConfig, simplifyLevels, type SimplifyLevel } from "./config.js";
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

  try {
    const config = await loadConfig(configPath);
    if (values.simplify !== undefined) {
      if (!isSimplifyLevel(values.simplify)) {
        console.error(`Unbekannte Stufe "${values.simplify}". Erlaubt: ${simplifyLevels.join(", ")}.`);
        return 1;
      }
      config.simplify = { ...config.simplify, level: values.simplify };
    }
    const inkscapePath = await resolveInkscapeBinary(config.inkscapePath);
    const files =
      positionals.length === 1
        ? [await resolveSingleFile(positionals[0] as string, config)]
        : await collectBatchFiles(config);

    if (files.length === 0) {
      console.log(`Keine passenden Dateien in ${config.inputDir}`);
      return 0;
    }

    const started = performance.now();
    const outcomes = await runBatch(config, files, inkscapePath);
    printSummary(outcomes, (performance.now() - started) / 1000);
    return outcomes.some((outcome) => outcome.status === "error") ? 1 : 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof BatchError || error instanceof InkscapeError) {
      console.error(error.message);
      return 1;
    }
    throw error;
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
