import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

export type SilhouetteTrace = { ok: true; d: string; viewBox: string } | { ok: false; message: string };

export async function traceSilhouette(options: {
  inkscapePath: string;
  inputPath: string;
  speckles: number;
  smoothCorners: number;
  optimize: number;
  timeoutMs: number;
}): Promise<SilhouetteTrace> {
  return traceMask({ ...options, missingMessage: "Silhouette nicht gefunden" });
}

export async function traceMask(options: {
  inkscapePath: string;
  inputPath: string;
  speckles: number;
  smoothCorners: number;
  optimize: number;
  timeoutMs: number;
  missingMessage?: string;
}): Promise<SilhouetteTrace> {
  const outputPath = path.join(tmpdir(), `vectorizer-mask-${process.pid}-${randomUUID()}.svg`);
  try {
    const traced = await traceToSvg({
      inkscapePath: options.inkscapePath,
      inputPath: options.inputPath,
      outputPath,
      timeoutMs: options.timeoutMs,
      trace: {
        scans: 2,
        smooth: false,
        stack: false,
        removeBackground: false,
        speckles: options.speckles,
        smoothCorners: options.smoothCorners,
        optimize: options.optimize,
      },
    });
    if (!traced.ok) {
      return traced;
    }
    const svg = await readFile(outputPath, "utf8");
    const viewBox = readViewBox(svg);
    const silhouette = darkestPath(svg);
    if (!viewBox || !silhouette) {
      return { ok: false, message: options.missingMessage ?? "Fläche nicht gefunden" };
    }
    return { ok: true, d: silhouette, viewBox };
  } finally {
    await rm(outputPath, { force: true });
  }
}

export function readViewBox(svg: string): string | null {
  return /viewBox="([^"]+)"/.exec(svg)?.[1]?.trim() ?? null;
}

function darkestPath(svg: string): string | null {
  let best: { d: string; luminance: number } | null = null;
  for (const match of svg.matchAll(/<path\b([\s\S]*?)\/>/g)) {
    const body = match[1] ?? "";
    const d = /\bd="([^"]+)"/.exec(body)?.[1];
    const fill = readPathFill(body);
    if (!d || !fill) {
      continue;
    }
    const luminance = 0.2126 * fill.r + 0.7152 * fill.g + 0.0722 * fill.b;
    if (luminance >= 128) {
      continue;
    }
    if (!best || luminance < best.luminance) {
      best = { d, luminance };
    }
  }
  return best?.d ?? null;
}

function readPathFill(body: string): { r: number; g: number; b: number } | null {
  const style = /\bstyle="([^"]*)"/.exec(body)?.[1] ?? "";
  const fromStyle = /(?:^|;)\s*fill:\s*([^;]+)/i.exec(style)?.[1];
  const raw = (fromStyle ?? /\bfill="([^"]+)"/.exec(body)?.[1] ?? "").trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (!hex?.[1]) {
    return null;
  }
  const value = hex[1].length === 3 ? [...hex[1]].map((part) => `${part}${part}`).join("") : hex[1];
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
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
