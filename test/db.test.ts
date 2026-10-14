import { Client } from "pg";
import { describe, expect, it } from "vitest";
import type { FileOutcome } from "../src/batch.ts";
import { assetRowFromOutcome, loadDatabaseUrl, openBatchLog } from "../src/db.ts";

const ok: FileOutcome = {
  status: "ok",
  inputName: "notiz.png",
  outputName: "notiz.svg",
  seconds: 4.2,
  scans: 5,
  smooth: false,
  bytes: 33000,
  transparent: true,
  speckles: 30,
  specklesAuto: false,
  medianSize: 0,
  medianAuto: false,
  flatColors: 5,
};

describe("assetRowFromOutcome", () => {
  it("übernimmt Status, Dauer und die Werte der Fortschrittszeile", () => {
    expect(assetRowFromOutcome(ok, 3)).toEqual({
      position: 3,
      inputName: "notiz.png",
      outputName: "notiz.svg",
      status: "ok",
      durationSeconds: 4.2,
      outputBytes: 33000,
      scans: 5,
      smooth: false,
      transparent: true,
      speckles: 30,
      specklesAuto: false,
      medianSize: 0,
      medianAuto: false,
      flatColors: 5,
      errorMessage: null,
    });
  });

  it("lässt die Trace-Werte bei Fehler und beim Überspringen leer", () => {
    expect(
      assetRowFromOutcome({ status: "error", inputName: "leer.png", message: "kaputt", seconds: 1.5 }, 1),
    ).toMatchObject({
      status: "error",
      durationSeconds: 1.5,
      outputBytes: null,
      scans: null,
      flatColors: null,
      errorMessage: "kaputt",
    });
    expect(assetRowFromOutcome({ status: "skipped", inputName: "alt.png" }, 2)).toMatchObject({
      status: "skipped",
      outputName: null,
      durationSeconds: null,
      outputBytes: null,
      errorMessage: null,
    });
  });
});

const reachable = await postgresReplies();

describe("openBatchLog", () => {
  it.skipIf(!reachable)("schreibt einen Lauf und ein Bild und räumt beides wieder ab", async () => {
    const log = await openBatchLog({
      inputDir: "C:/input",
      outputDir: "C:/output",
      configPath: "C:/vectorizer.config.json",
      config: { trace: { scans: 5 }, "--Hinweis": "bleibt erhalten" },
      simplifyOverride: "light",
      singleFile: "notiz.png",
      fileCount: 1,
    });
    const client = new Client({ connectionString: loadDatabaseUrl() });
    await client.connect();
    try {
      await log.insertAsset(ok, 1);
      await log.finish({
        durationSeconds: 4.2,
        outcomes: [ok],
        status: "completed",
        exitCode: 0,
        errorMessage: null,
      });

      const run = await client.query<{
        status: string;
        ok_count: number;
        simplify_override: string;
        hint: string;
      }>(
        `SELECT status, ok_count, simplify_override, config->>'--Hinweis' AS hint
         FROM batch_runs WHERE id = $1`,
        [log.batchId],
      );
      const asset = await client.query<{ status: string; output_bytes: string; flat_colors: number }>(
        `SELECT status, output_bytes, flat_colors FROM batch_assets WHERE batch_id = $1`,
        [log.batchId],
      );
      expect(run.rows[0]).toMatchObject({
        status: "completed",
        ok_count: 1,
        simplify_override: "light",
        hint: "bleibt erhalten",
      });
      expect(asset.rows).toHaveLength(1);
      expect(asset.rows[0]).toMatchObject({ status: "ok", output_bytes: "33000", flat_colors: 5 });
    } finally {
      await client.query("DELETE FROM batch_runs WHERE id = $1", [log.batchId]);
      await client.end();
      await log.close();
    }
  });
});

async function postgresReplies(): Promise<boolean> {
  try {
    const url = new URL(loadDatabaseUrl());
    url.pathname = "/postgres";
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}
