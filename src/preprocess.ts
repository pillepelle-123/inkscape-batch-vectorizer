import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

export async function writeMedianPng(inputPath: string, medianSize: number): Promise<string> {
  const outputPath = path.join(tmpdir(), `vectorizer-${process.pid}-${randomUUID()}.png`);
  await sharp(inputPath).median(medianSize).png().toFile(outputPath);
  return outputPath;
}
