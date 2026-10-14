import { describe, expect, it } from "vitest";
import { buildTraceActions, formatTraceNumber, InkscapeError, toActionPath } from "../src/inkscape.ts";
import type { ResolvedTraceSettings } from "../src/config.ts";

const trace: ResolvedTraceSettings = {
  scans: 8,
  smooth: true,
  stack: false,
  removeBackground: true,
  speckles: 2,
  smoothCorners: 1.34,
  optimize: 0.2,
};

describe("buildTraceActions", () => {
  it("baut den Mehrfarb-Trace mit true/false und Punkt als Dezimaltrennzeichen", () => {
    const actions = buildTraceActions("C:/out/logo.svg", trace);
    expect(actions).toBe(
      [
        "select-by-element:image",
        "object-trace:8,true,false,true,2,1.34,0.2",
        "select-clear",
        "select-by-element:image",
        "delete",
        "export-filename:C:/out/logo.svg",
        "export-plain-svg",
        "export-overwrite",
        "export-do",
      ].join(";"),
    );
  });

  it("formatiert Zahlen unabhängig von der Locale mit einem Punkt", () => {
    const previous = process.env.LC_ALL;
    process.env.LC_ALL = "de_DE";
    try {
      expect(formatTraceNumber(1.34)).toBe("1.34");
      expect(formatTraceNumber(5)).toBe("5");
      expect(formatTraceNumber(0)).toBe("0");
    } finally {
      if (previous === undefined) {
        delete process.env.LC_ALL;
      } else {
        process.env.LC_ALL = previous;
      }
    }
  });
});

describe("toActionPath", () => {
  it("wandelt Backslashes in Schrägstriche um", () => {
    expect(toActionPath("C:\\bilder\\logo.svg")).toBe("C:/bilder/logo.svg");
  });

  it("lehnt Semikolons im Pfad ab", () => {
    expect(() => toActionPath("C:/bilder/a;b.svg")).toThrow(InkscapeError);
  });
});
