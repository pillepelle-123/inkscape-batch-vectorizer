import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool, type Pool as PgPool } from "pg";
import type { FileOutcome } from "./batch.js";

export class LogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LogError";
  }
}

export type AssetLogRow = {
  position: number;
  inputName: string;
  outputName: string | null;
  status: FileOutcome["status"];
  durationSeconds: number | null;
  outputBytes: number | null;
  scans: number | null;
  smooth: boolean | null;
  transparent: boolean | null;
  speckles: number | null;
  specklesAuto: boolean | null;
  medianSize: number | null;
  medianAuto: boolean | null;
  flatColors: number | null;
  errorMessage: string | null;
};

export type BatchFinish = {
  durationSeconds: number;
  outcomes: FileOutcome[];
  status: "completed" | "aborted";
  exitCode: number;
  errorMessage: string | null;
};

export type BatchLog = {
  batchId: number;
  insertAsset(outcome: FileOutcome, position: number): Promise<void>;
  finish(result: BatchFinish): Promise<void>;
  close(): Promise<void>;
};

export function assetRowFromOutcome(outcome: FileOutcome, position: number): AssetLogRow {
  if (outcome.status === "ok") {
    return {
      position,
      inputName: outcome.inputName,
      outputName: outcome.outputName,
      status: outcome.status,
      durationSeconds: outcome.seconds,
      outputBytes: outcome.bytes,
      scans: outcome.scans,
      smooth: outcome.smooth,
      transparent: outcome.transparent,
      speckles: outcome.speckles,
      specklesAuto: outcome.specklesAuto,
      medianSize: outcome.medianSize,
      medianAuto: outcome.medianAuto,
      flatColors: outcome.flatColors,
      errorMessage: null,
    };
  }
  if (outcome.status === "error") {
    return {
      position,
      inputName: outcome.inputName,
      outputName: null,
      status: outcome.status,
      durationSeconds: outcome.seconds,
      outputBytes: null,
      scans: null,
      smooth: null,
      transparent: null,
      speckles: null,
      specklesAuto: null,
      medianSize: null,
      medianAuto: null,
      flatColors: null,
      errorMessage: outcome.message,
    };
  }
  return {
    position,
    inputName: outcome.inputName,
    outputName: null,
    status: outcome.status,
    durationSeconds: null,
    outputBytes: null,
    scans: null,
    smooth: null,
    transparent: null,
    speckles: null,
    specklesAuto: null,
    medianSize: null,
    medianAuto: null,
    flatColors: null,
    errorMessage: null,
  };
}

export function loadDatabaseUrl(): string {
  try {
    process.loadEnvFile(path.resolve(".env"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw asLogError(error);
    }
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new LogError("DATABASE_URL fehlt");
  }
  return url;
}

export async function openBatchLog(input: {
  inputDir: string;
  outputDir: string;
  configPath: string;
  config: unknown;
  simplifyOverride: string | null;
  singleFile: string | null;
  fileCount: number;
}): Promise<BatchLog> {
  try {
    const databaseUrl = loadDatabaseUrl();
    const pool = await connectPool(databaseUrl);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO batch_runs (
         input_dir, output_dir, config_path, config, simplify_override, single_file, file_count, status
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'running')
       RETURNING id`,
      [
        input.inputDir,
        input.outputDir,
        input.configPath,
        JSON.stringify(input.config),
        input.simplifyOverride,
        input.singleFile,
        input.fileCount,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) {
      await pool.end();
      throw new LogError("Batch-Zeile hat keine Nummer bekommen");
    }
    const batchId = Number(id);
    return {
      batchId,
      async insertAsset(outcome, position) {
        const row = assetRowFromOutcome(outcome, position);
        try {
          await pool.query(
            `INSERT INTO batch_assets (
               batch_id, position, input_name, output_name, status, duration_seconds, output_bytes,
               scans, smooth, transparent, speckles, speckles_auto, median_size, median_auto,
               flat_colors, error_message
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12, $13, $14,
               $15, $16
             )`,
            [
              batchId,
              row.position,
              row.inputName,
              row.outputName,
              row.status,
              row.durationSeconds,
              row.outputBytes,
              row.scans,
              row.smooth,
              row.transparent,
              row.speckles,
              row.specklesAuto,
              row.medianSize,
              row.medianAuto,
              row.flatColors,
              row.errorMessage,
            ],
          );
        } catch (error) {
          throw asLogError(error);
        }
      },
      async finish(result) {
        const counts = countOutcomes(result.outcomes);
        try {
          await pool.query(
            `UPDATE batch_runs
             SET finished_at = now(),
                 duration_seconds = $2,
                 ok_count = $3,
                 skipped_count = $4,
                 error_count = $5,
                 status = $6,
                 exit_code = $7,
                 error_message = $8
             WHERE id = $1`,
            [
              batchId,
              result.durationSeconds,
              counts.ok,
              counts.skipped,
              counts.error,
              result.status,
              result.exitCode,
              result.errorMessage,
            ],
          );
        } catch (error) {
          throw asLogError(error);
        }
      },
      async close() {
        await pool.end();
      },
    };
  } catch (error) {
    throw asLogError(error);
  }
}

async function connectPool(databaseUrl: string): Promise<PgPool> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const client = await pool.connect();
    client.release();
  } catch (error) {
    await pool.end();
    if (!isMissingDatabase(error)) {
      throw error;
    }
    await createDatabase(databaseUrl);
    const created = new Pool({ connectionString: databaseUrl });
    try {
      await applySchema(created);
      return created;
    } catch (schemaError) {
      await created.end();
      throw schemaError;
    }
  }
  try {
    await applySchema(pool);
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function createDatabase(databaseUrl: string): Promise<void> {
  const target = new URL(databaseUrl);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!databaseName) {
    throw new LogError("DATABASE_URL enthält keinen Datenbanknamen");
  }
  target.pathname = "/postgres";
  const client = new Client({ connectionString: target.toString() });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "42P04") {
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function applySchema(pool: PgPool): Promise<void> {
  const schemaPath = fileURLToPath(new URL("../sql/schema.sql", import.meta.url));
  const sql = await readFile(schemaPath, "utf8");
  await pool.query(sql);
}

function countOutcomes(outcomes: FileOutcome[]): { ok: number; skipped: number; error: number } {
  return {
    ok: outcomes.filter((outcome) => outcome.status === "ok").length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    error: outcomes.filter((outcome) => outcome.status === "error").length,
  };
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function isMissingDatabase(error: unknown): boolean {
  return (error as { code?: string }).code === "3D000";
}

function asLogError(error: unknown): LogError {
  if (error instanceof LogError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LogError(message, { cause: error });
}
