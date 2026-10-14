import { readFile, writeFile } from "node:fs/promises";
import { optimize, type PluginConfig } from "svgo";

export async function optimizeSvgFile(
  filePath: string,
  precision: number,
  options: { compress?: boolean; plugins?: PluginConfig[] } = {},
): Promise<void> {
  const compress = options.compress ?? true;
  const extra = options.plugins ?? [];
  const plugins: PluginConfig[] = compress
    ? [
        ...extra,
        {
          name: "preset-default",
          params: {
            floatPrecision: precision,
            overrides: {
              convertPathData: { floatPrecision: precision },
            },
          },
        },
      ]
    : extra;
  if (plugins.length === 0) {
    return;
  }

  const source = await readFile(filePath, "utf8");
  const result = optimize(source, {
    multipass: compress,
    floatPrecision: compress ? precision : undefined,
    plugins,
  });

  if (source.includes("viewBox") && !result.data.includes("viewBox")) {
    throw new Error("SVGO hat die viewBox entfernt");
  }

  await writeFile(filePath, result.data, "utf8");
}
