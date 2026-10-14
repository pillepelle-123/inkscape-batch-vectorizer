import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ResolvedTraceSettings } from "./config.js";

const execFileAsync = promisify(execFile);

const WINDOWS_DEFAULT = "C:\\Program Files\\Inkscape\\bin\\inkscape.com";

export class InkscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InkscapeError";
  }
}

export function formatTraceNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new InkscapeError(`Trace-Wert ist keine endliche Zahl: ${value}`);
  }
  return Object.is(value, -0) ? "0" : value.toString();
}

/** Inkscape trennt Actions mit `;`. Schrägstriche bleiben auf Windows gültig. */
export function toActionPath(filePath: string): string {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  if (normalized.includes(";")) {
    throw new InkscapeError(
      `Pfad enthält ein Semikolon und kann nicht an die Inkscape-Actions übergeben werden: ${filePath}`,
    );
  }
  return normalized;
}

export function buildTraceActions(outputPath: string, trace: ResolvedTraceSettings): string {
  const flag = (value: boolean) => (value ? "true" : "false");
  const params = [
    String(trace.scans),
    flag(trace.smooth),
    flag(trace.stack),
    flag(trace.removeBackground),
    String(trace.speckles),
    formatTraceNumber(trace.smoothCorners),
    formatTraceNumber(trace.optimize),
  ].join(",");

  // select-by-element ergänzt die Auswahl. Ohne select-clear löscht delete auch die neuen Pfade.
  return [
    "select-by-element:image",
    `object-trace:${params}`,
    "select-clear",
    "select-by-element:image",
    "delete",
    `export-filename:${toActionPath(outputPath)}`,
    "export-plain-svg",
    "export-overwrite",
    "export-do",
  ].join(";");
}

export async function resolveInkscapeBinary(configured: string | null): Promise<string> {
  if (configured) {
    await assertExists(configured);
    return configured;
  }

  const binaryName = process.platform === "win32" ? "inkscape.com" : "inkscape";
  const fromPath = await findOnPath(binaryName);
  if (fromPath) {
    return fromPath;
  }

  if (process.platform === "win32") {
    try {
      await assertExists(WINDOWS_DEFAULT);
      return WINDOWS_DEFAULT;
    } catch (error) {
      if (!(error instanceof InkscapeError)) {
        throw error;
      }
    }
  }

  throw new InkscapeError(
    "Inkscape wurde nicht gefunden. Setze inkscapePath in der Config oder nimm inkscape.com in den PATH auf.",
  );
}

async function assertExists(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    throw new InkscapeError(`Inkscape-Programm nicht gefunden: ${filePath}`);
  }
}

async function findOnPath(binaryName: string): Promise<string | null> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await execFileAsync(locator, [binaryName], { windowsHide: true });
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}

export type TraceRunResult = { ok: true } | { ok: false; message: string };

export async function traceToSvg(options: {
  inkscapePath: string;
  inputPath: string;
  outputPath: string;
  trace: ResolvedTraceSettings;
  timeoutMs: number;
}): Promise<TraceRunResult> {
  let actions: string;
  try {
    actions = buildTraceActions(options.outputPath, options.trace);
  } catch (error) {
    if (error instanceof InkscapeError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  try {
    await execFileAsync(options.inkscapePath, [options.inputPath, `--actions=${actions}`], {
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string | null;
      stderr?: string;
      stdout?: string;
    };
    if (err.killed || err.signal === "SIGTERM") {
      return {
        ok: false,
        message: `Zeitüberschreitung nach ${Math.round(options.timeoutMs / 1000)} s`,
      };
    }
    const detail = excerpt(err.stderr) || excerpt(err.stdout) || err.message;
    return { ok: false, message: detail };
  }

  let svg: string;
  try {
    svg = await readFile(options.outputPath, "utf8");
  } catch {
    return { ok: false, message: "Inkscape hat keine SVG-Datei geschrieben" };
  }

  if (!svg.includes("<path")) {
    return { ok: false, message: "SVG enthält keine Vektorpfade" };
  }
  if (/<image[\s/>]/.test(svg)) {
    return { ok: false, message: "Die Original-Bitmap ist noch in der SVG enthalten" };
  }
  return { ok: true };
}

function excerpt(text: string | undefined): string {
  if (!text) {
    return "";
  }
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= 180) {
    return line;
  }
  return `${line.slice(0, 177)}...`;
}
