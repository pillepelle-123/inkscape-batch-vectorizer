import type { ColorAnalysis } from "./analyze.js";
import type { ResolvedTraceSettings, SimplifySettings, TraceSettings } from "./config.js";

type LevelAdjust = {
  maxColors: number | null;
  medianSize: number;
  specklesFactor: number;
  optimizeAdd: number;
  smoothCornersAdd: number;
  svgoPrecision: number;
};

const LEVELS: Record<SimplifySettings["level"], LevelAdjust> = {
  off: { maxColors: null, medianSize: 0, specklesFactor: 1, optimizeAdd: 0, smoothCornersAdd: 0, svgoPrecision: 2 },
  light: {
    maxColors: 16,
    medianSize: 0,
    specklesFactor: 1.5,
    optimizeAdd: 0.25,
    smoothCornersAdd: 0.05,
    svgoPrecision: 2,
  },
  medium: {
    maxColors: 8,
    medianSize: 3,
    specklesFactor: 2,
    optimizeAdd: 0.5,
    smoothCornersAdd: 0.1,
    svgoPrecision: 1,
  },
  strong: {
    maxColors: 4,
    medianSize: 5,
    specklesFactor: 3,
    optimizeAdd: 1,
    smoothCornersAdd: 0.2,
    svgoPrecision: 1,
  },
};

export type EffectiveTrace = ResolvedTraceSettings & {
  medianSize: number;
  svgo: boolean;
  svgoPrecision: number;
  keyBackground: boolean;
  stackSuppressed: boolean;
};

export class SimplifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimplifyError";
  }
}

export function resolveTrace(options: {
  trace: TraceSettings;
  simplify: SimplifySettings;
  analysis: ColorAnalysis | null;
}): EffectiveTrace {
  const level = LEVELS[options.simplify.level];
  const maxColors = options.simplify.maxColors ?? level.maxColors;
  const medianSize = options.simplify.medianSize ?? level.medianSize;
  const svgoPrecision = options.simplify.svgoPrecision ?? level.svgoPrecision;

  let scans = options.trace.scans === "auto" ? scansFromAnalysis(options) : options.trace.scans;
  if (maxColors !== null) {
    scans = Math.min(scans, maxColors);
  }

  const smooth = options.trace.smooth === "auto" ? requireAnalysis(options.analysis).smooth : options.trace.smooth;
  const keyBackground = options.trace.removeBackground && (options.analysis?.hasTransparency ?? false);
  const stackSuppressed = keyBackground && options.trace.stack;

  return {
    scans: clamp(Math.round(scans), 2, 256),
    smooth,
    stack: stackSuppressed ? false : options.trace.stack,
    removeBackground: false,
    speckles: clamp(Math.round(options.trace.speckles * level.specklesFactor), 0, 1000),
    smoothCorners: roundTo(clamp(options.trace.smoothCorners + level.smoothCornersAdd, 0, 1.34), 2),
    optimize: roundTo(clamp(options.trace.optimize + level.optimizeAdd, 0, 5), 3),
    medianSize,
    svgo: options.simplify.svgo,
    svgoPrecision,
    keyBackground,
    stackSuppressed,
  };
}

function scansFromAnalysis(options: { analysis: ColorAnalysis | null }): number {
  const analysis = requireAnalysis(options.analysis);
  // Die transparente Fläche wird zur Schlüsselfarbe und braucht einen eigenen Scan.
  return analysis.colors + (analysis.hasTransparency ? 1 : 0);
}

function requireAnalysis(analysis: ColorAnalysis | null): ColorAnalysis {
  if (!analysis) {
    throw new SimplifyError("Für automatische Trace-Werte fehlt die Farbanalyse.");
  }
  return analysis;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
