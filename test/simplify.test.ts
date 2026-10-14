import { describe, expect, it } from "vitest";
import type { ColorAnalysis } from "../src/analyze.ts";
import type { SimplifySettings, TraceSettings } from "../src/config.ts";
import type { DetailAnalysis } from "../src/detail.ts";
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

  it("zählt den transparenten Hintergrund nur ohne Silhouette", () => {
    const clipped = resolveTrace({
      trace: { ...trace, scans: "auto", smooth: "auto" },
      simplify: { ...simplify, level: "light" },
      analysis,
    });
    expect(clipped.scans).toBe(10);
    expect(clipped.smooth).toBe(false);

    const kept = resolveTrace({
      trace: { ...trace, scans: "auto", smooth: "auto", removeBackground: false },
      simplify: { ...simplify, level: "light" },
      analysis,
    });
    expect(kept.scans).toBe(11);
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

  it("schneidet transparente Hintergründe aus und lässt das Stapeln an", () => {
    const result = resolveTrace({ trace, simplify, analysis });
    expect(result.clipBackground).toBe(true);
    expect(result.removeBackground).toBe(false);
    expect(result.stack).toBe(true);
  });

  it("lässt deckende Bilder und ausgeschaltetes removeBackground unverändert", () => {
    const opaque = resolveTrace({
      trace,
      simplify,
      analysis: { ...analysis, hasTransparency: false },
    });
    expect(opaque.clipBackground).toBe(false);
    expect(opaque.stack).toBe(true);
    expect(opaque.removeBackground).toBe(false);

    const disabled = resolveTrace({
      trace: { ...trace, removeBackground: false },
      simplify,
      analysis,
    });
    expect(disabled.clipBackground).toBe(false);
    expect(disabled.stack).toBe(true);
  });

  it("übernimmt automatische speckles und den Median ohne Stufenfaktor", () => {
    const detail: DetailAnalysis = {
      speckles: 24,
      medianSize: 3,
      highlights: 2,
      smallestHighlight: 30,
      noise: 4,
    };
    const result = resolveTrace({
      trace: { ...trace, speckles: "auto" },
      simplify: { ...simplify, level: "strong", medianSize: "auto" },
      analysis: null,
      detail,
    });
    expect(result.speckles).toBe(24);
    expect(result.medianSize).toBe(3);
    expect(result.specklesAuto).toBe(true);
    expect(result.medianAuto).toBe(true);
    expect(result.scans).toBe(4);
    expect(result.optimize).toBe(4.25);
  });

  it("verlangt eine Detailanalyse, wenn speckles oder der Median auf auto steht", () => {
    expect(() =>
      resolveTrace({ trace: { ...trace, speckles: "auto" }, simplify, analysis: null, detail: null }),
    ).toThrow(SimplifyError);
    expect(() =>
      resolveTrace({ trace, simplify: { ...simplify, medianSize: "auto" }, analysis: null }),
    ).toThrow(SimplifyError);
  });
});
