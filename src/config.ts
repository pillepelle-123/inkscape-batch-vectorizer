import { readFile } from "node:fs/promises";
import path from "node:path";
import { config as configureZod, z } from "zod";
import { de } from "zod/locales";

configureZod(de());

const extensionSchema = z
  .string("Dateiendung als Text erwartet")
  .regex(/^\.[a-z0-9]+$/i, "Dateiendung muss mit einem Punkt beginnen, z. B. .png");

const scansSchema = z.union(
  [
    z.literal("auto"),
    z
      .number("Ganzzahl von 2 bis 256 oder \"auto\" erwartet")
      .int("Ganzzahl von 2 bis 256 oder \"auto\" erwartet")
      .min(2, "Ganzzahl von 2 bis 256 oder \"auto\" erwartet")
      .max(256, "Ganzzahl von 2 bis 256 oder \"auto\" erwartet"),
  ],
  "Ganzzahl von 2 bis 256 oder \"auto\" erwartet",
);

const smoothSchema = z.union(
  [z.literal("auto"), z.boolean("true, false oder \"auto\" erwartet")],
  "true, false oder \"auto\" erwartet",
);

const oddKernelSchema = z
  .number("0, eine ungerade Ganzzahl von 1 bis 15, null oder \"auto\" erwartet")
  .int("0, eine ungerade Ganzzahl von 1 bis 15, null oder \"auto\" erwartet")
  .min(0, "0 oder eine ungerade Ganzzahl von 1 bis 15 erwartet")
  .max(15, "0 oder eine ungerade Ganzzahl von 1 bis 15 erwartet")
  .refine((value) => value === 0 || value % 2 === 1, "0 oder eine ungerade Ganzzahl von 1 bis 15 erwartet");

const specklesSchema = z.union(
  [
    z.literal("auto"),
    z
      .number("Ganzzahl von 0 bis 1000 oder \"auto\" erwartet")
      .int("Ganzzahl von 0 bis 1000 oder \"auto\" erwartet")
      .min(0, "Ganzzahl von 0 bis 1000 oder \"auto\" erwartet")
      .max(1000, "Ganzzahl von 0 bis 1000 oder \"auto\" erwartet"),
  ],
  "Ganzzahl von 0 bis 1000 oder \"auto\" erwartet",
);

const medianSizeSchema = z.union(
  [z.literal("auto"), z.null(), oddKernelSchema],
  "0, eine ungerade Ganzzahl von 1 bis 15, null oder \"auto\" erwartet",
);

export const simplifyLevels = ["off", "light", "medium", "strong"] as const;

export const traceSettingsSchema = z.object({
  scans: scansSchema,
  smooth: smoothSchema,
  stack: z.boolean("true oder false erwartet"),
  removeBackground: z.boolean("true oder false erwartet"),
  speckles: specklesSchema,
  smoothCorners: z
    .number("Zahl erwartet")
    .min(0, "Zahl von 0 bis 1.34 erwartet")
    .max(1.34, "Zahl von 0 bis 1.34 erwartet"),
  optimize: z
    .number("Zahl erwartet")
    .min(0, "Zahl von 0 bis 5 erwartet")
    .max(5, "Zahl von 0 bis 5 erwartet"),
});

export const autoColorsSchema = z
  .object({
    minColorDistance: z
      .number("Zahl erwartet")
      .min(0, "Zahl von 0 bis 100 erwartet")
      .max(100, "Zahl von 0 bis 100 erwartet")
      .default(10),
    minColorShare: z
      .number("Zahl erwartet")
      .min(0, "Zahl von 0 bis 1 erwartet")
      .max(1, "Zahl von 0 bis 1 erwartet")
      .default(0.005),
  })
  .default({ minColorDistance: 10, minColorShare: 0.005 });

export const simplifySchema = z
  .object({
    level: z.enum(simplifyLevels, "off, light, medium oder strong erwartet").default("off"),
    maxColors: z
      .number("Ganzzahl von 2 bis 256 oder null erwartet")
      .int("Ganzzahl von 2 bis 256 oder null erwartet")
      .min(2, "Ganzzahl von 2 bis 256 oder null erwartet")
      .max(256, "Ganzzahl von 2 bis 256 oder null erwartet")
      .nullable()
      .default(null),
    medianSize: medianSizeSchema.default(null),
    svgo: z.boolean("true oder false erwartet").default(true),
    svgoPrecision: z
      .number("Ganzzahl von 0 bis 8 oder null erwartet")
      .int("Ganzzahl von 0 bis 8 oder null erwartet")
      .min(0, "Ganzzahl von 0 bis 8 oder null erwartet")
      .max(8, "Ganzzahl von 0 bis 8 oder null erwartet")
      .nullable()
      .default(null),
  })
  .default({
    level: "off",
    maxColors: null,
    medianSize: null,
    svgo: true,
    svgoPrecision: null,
  });

export const flatColorModes = ["off", "flat", "auto"] as const;

export const flatColorsSchema = z
  .object({
    mode: z.enum(flatColorModes, "off, flat oder auto erwartet").default("off"),
    colorDistance: z
      .number("Zahl von 0 bis 100 erwartet")
      .min(0, "Zahl von 0 bis 100 erwartet")
      .max(100, "Zahl von 0 bis 100 erwartet")
      .default(12),
    maxColors: z
      .number("Ganzzahl von 2 bis 32 erwartet")
      .int("Ganzzahl von 2 bis 32 erwartet")
      .min(2, "Ganzzahl von 2 bis 32 erwartet")
      .max(32, "Ganzzahl von 2 bis 32 erwartet")
      .default(12),
    dilate: z
      .number("Ganzzahl von 0 bis 8 erwartet")
      .int("Ganzzahl von 0 bis 8 erwartet")
      .min(0, "Ganzzahl von 0 bis 8 erwartet")
      .max(8, "Ganzzahl von 0 bis 8 erwartet")
      .default(2),
  })
  .default({ mode: "off", colorDistance: 12, maxColors: 12, dilate: 2 });

export const autoDetailSchema = z
  .object({
    maxSpeckles: z
      .number("Ganzzahl von 0 bis 1000 erwartet")
      .int("Ganzzahl von 0 bis 1000 erwartet")
      .min(0, "Ganzzahl von 0 bis 1000 erwartet")
      .max(1000, "Ganzzahl von 0 bis 1000 erwartet")
      .default(100),
  })
  .default({ maxSpeckles: 100 });

export const configFileSchema = z.object({
  inputDir: z.string("Text erwartet").min(1, "Darf nicht leer sein"),
  outputDir: z.string("Text erwartet").min(1, "Darf nicht leer sein"),
  extensions: z
    .array(extensionSchema, "Liste von Dateiendungen erwartet")
    .min(1, "Mindestens eine Dateiendung")
    .default([".png", ".jpg", ".jpeg"]),
  overwrite: z.boolean("true oder false erwartet").default(true),
  concurrency: z
    .number("Zahl erwartet")
    .int("Ganzzahl erwartet")
    .min(1, "Ganzzahl ab 1 erwartet")
    .default(2),
  timeoutSeconds: z
    .number("Zahl erwartet")
    .int("Ganzzahl erwartet")
    .min(1, "Ganzzahl ab 1 erwartet")
    .default(120),
  inkscapePath: z.string("Text oder null erwartet").min(1, "Darf nicht leer sein").nullable().default(null),
  trace: traceSettingsSchema,
  autoColors: autoColorsSchema,
  autoDetail: autoDetailSchema,
  flatColors: flatColorsSchema,
  simplify: simplifySchema,
});

export type TraceSettings = z.infer<typeof traceSettingsSchema>;
export type AutoColors = z.infer<typeof autoColorsSchema>;
export type AutoDetail = z.infer<typeof autoDetailSchema>;
export type FlatColors = z.infer<typeof flatColorsSchema>;
export type SimplifyLevel = (typeof simplifyLevels)[number];
export type SimplifySettings = z.infer<typeof simplifySchema>;
export type ConfigFile = z.infer<typeof configFileSchema>;

/** Trace-Werte, nachdem auto und die Vereinfachungsstufe aufgelöst sind. */
export type ResolvedTraceSettings = {
  scans: number;
  smooth: boolean;
  stack: boolean;
  removeBackground: boolean;
  speckles: number;
  smoothCorners: number;
  optimize: number;
};

export type Config = {
  inputDir: string;
  outputDir: string;
  extensions: string[];
  overwrite: boolean;
  concurrency: number;
  timeoutSeconds: number;
  inkscapePath: string | null;
  trace: TraceSettings;
  autoColors: AutoColors;
  autoDetail: AutoDetail;
  flatColors: FlatColors;
  simplify: SimplifySettings;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function formatConfigIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(Datei)";
    return `- ${field}: ${issue.message}`;
  });
  return `Ungültige Konfiguration:\n${lines.join("\n")}`;
}

export function resolveConfig(raw: ConfigFile, configDir: string): Config {
  return {
    inputDir: path.resolve(configDir, raw.inputDir),
    outputDir: path.resolve(configDir, raw.outputDir),
    extensions: raw.extensions.map((extension) => extension.toLowerCase()),
    overwrite: raw.overwrite,
    concurrency: raw.concurrency,
    timeoutSeconds: raw.timeoutSeconds,
    inkscapePath: raw.inkscapePath === null ? null : path.resolve(configDir, raw.inkscapePath),
    trace: raw.trace,
    autoColors: raw.autoColors,
    autoDetail: raw.autoDetail,
    flatColors: raw.flatColors,
    simplify: raw.simplify,
  };
}

export async function loadConfig(configPath: string): Promise<Config> {
  const absoluteConfig = path.resolve(configPath);
  let text: string;
  try {
    text = await readFile(absoluteConfig, "utf8");
    text = text.replace(/^\uFEFF/, "");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(`Konfigurationsdatei nicht gefunden: ${absoluteConfig}`);
    }
    throw new ConfigError(`Konfigurationsdatei konnte nicht gelesen werden: ${absoluteConfig}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Konfigurationsdatei ist kein gültiges JSON: ${message}`);
  }

  const parsed = configFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(formatConfigIssues(parsed.error));
  }

  return resolveConfig(parsed.data, path.dirname(absoluteConfig));
}
