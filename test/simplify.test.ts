import { describe, expect, it } from "vitest";
import type { ColorAnalysis } from "../src/analyze.ts";
import type { SimplifySettings, TraceSettings } from "../src/config.ts";
import { resolveTrace, SimplifyError } from "../src/simplify.ts";

const trace: TraceSettings = {
  scans: 8,
  smooth: true,
  stack: true,
  removeBackground: true,
  speckles: 240,
  smoothCorners: 1.05,
  optimize: 3.25,
};

const simplify: SimplifySettings = {
  level: "off",
  maxColors: null,
  medianSize: null,
  svgo: true,
  svgoPrecision: null,
};

const analysis: ColorAnalysis = {
  colors: 10,
  outlierShare: 0.01,
  hasTransparency: true,
  smooth: false,
  palette: [],
};

describe("resolveTrace", () => {
  it("lässt die Config-Werte bei Stufe off unverändert", () => {
    expect(resolveTrace({ trace, simplify, analysis: null })).toMatchObject({
      scans: 8,
      smooth: true,
      speckles: 240,
      smoothCorners: 1.05,
      optimize: 3.25,
      medianSize: 0,
      svgo: true,
      svgoPrecision: 2,
    });
  });

  it("verstärkt die Trace-Werte relativ zur Stufe strong", () => {
    const result = resolveTrace({ trace, simplify: { ...simplify, level: "strong" }, analysis: null });
    expect(result).toMatchObject({
      scans: 4,
      speckles: 720,
      smoothCorners: 1.25,
      optimize: 4.25,
      medianSize: 5,
      svgoPrecision: 1,
    });
  });

  it("begrenzt Werte auf die erlaubten Bereiche", () => {
    const result = resolveTrace({
      trace: { ...trace, speckles: 900, smoothCorners: 1.3, optimize: 4.5 },
      simplify: { ...simplify, level: "strong" },
      analysis: null,
    });
    expect(result.speckles).toBe(1000);
    expect(result.smoothCorners).toBe(1.34);
    expect(result.optimize).toBe(5);
  });

  it("bevorzugt explizite simplify-Felder vor der Stufe", () => {
    const result = resolveTrace({
      trace,
      simplify: { ...simplify, level: "strong", maxColors: 12, medianSize: 1, svgoPrecision: 3 },
      analysis: null,
    });
    expect(result.scans).toBe(8);
    expect(result.medianSize).toBe(1);
    expect(result.svgoPrecision).toBe(3);
    expect(result.speckles).toBe(720);
  });

  it("deckt automatische Farben und zählt den transparenten Hintergrund", () => {
    const result = resolveTrace({
      trace: { ...trace, scans: "auto", smooth: "auto" },
      simplify: { ...simplify, level: "light" },
      analysis,
    });
    expect(result.scans).toBe(11);
    expect(result.smooth).toBe(false);
  });

  it("deckelt automatische Farben mit maxColors und bleibt bei mindestens 2", () => {
    const capped = resolveTrace({
      trace: { ...trace, scans: "auto" },
      simplify: { ...simplify, level: "strong" },
      analysis,
    });
    expect(capped.scans).toBe(4);

    const minimum = resolveTrace({
      trace: { ...trace, scans: "auto" },
      simplify,
      analysis: { ...analysis, colors: 1, hasTransparency: false },
    });
    expect(minimum.scans).toBe(2);
  });

  it("verlangt eine Farbanalyse, wenn ein Wert auf auto steht", () => {
    expect(() =>
      resolveTrace({ trace: { ...trace, scans: "auto" }, simplify, analysis: null }),
    ).toThrow(SimplifyError);
  });

  it("ersetzt transparente Hintergründe über eine Schlüsselfarbe und schaltet Stapeln aus", () => {
    const result = resolveTrace({ trace, simplify, analysis });
    expect(result.keyBackground).toBe(true);
    expect(result.removeBackground).toBe(false);
    expect(result.stack).toBe(false);
    expect(result.stackSuppressed).toBe(true);
  });

  it("lässt deckende Bilder und ausgeschaltetes removeBackground unverändert", () => {
    const opaque = resolveTrace({
      trace,
      simplify,
      analysis: { ...analysis, hasTransparency: false },
    });
    expect(opaque.keyBackground).toBe(false);
    expect(opaque.stack).toBe(true);
    expect(opaque.removeBackground).toBe(false);

    const disabled = resolveTrace({
      trace: { ...trace, removeBackground: false },
      simplify,
      analysis,
    });
    expect(disabled.keyBackground).toBe(false);
    expect(disabled.stack).toBe(true);
  });
});
