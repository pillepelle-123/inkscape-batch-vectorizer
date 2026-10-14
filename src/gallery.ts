import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const GALLERY_FILE = "_galerie.html";

export function isGalleryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GALLERY?.trim() === "true";
}

/** Schreibt die Galerie, wenn das Flag an ist. `null` heißt: ausgeschaltet. */
export async function updateGallery(
  outputDir: string,
  env?: NodeJS.ProcessEnv,
): Promise<number | null> {
  if (env === undefined) {
    loadEnvFile();
  }
  if (!isGalleryEnabled(env ?? process.env)) {
    return null;
  }
  return writeGallery(outputDir);
}

export async function writeGallery(outputDir: string): Promise<number> {
  const entries = await readdir(outputDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".svg"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "de", { numeric: true, sensitivity: "base" }));
  const html = renderGalleryPage(path.basename(outputDir), names);
  await writeFile(path.join(outputDir, GALLERY_FILE), html, "utf8");
  return names.length;
}

export function renderGalleryPage(folderName: string, fileNames: string[]): string {
  const cards =
    fileNames.length === 0
      ? `<p class="empty">Dieser Ordner enthält keine SVG-Dateien.</p>`
      : `<div class="grid">${fileNames.map(card).join("")}</div>`;
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(folderName)}</title>
  <style>
    body { margin: 0; background: #f3f0ea; color: #1d1c1a; font: 15px/1.4 system-ui, sans-serif; }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0; padding: 1.25rem 1.5rem 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 1rem; padding: 1.25rem; }
    .card { display: block; width: 100%; background: #fff; border: 0; border-radius: 12px; padding: 0.75rem; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); cursor: pointer; text-align: left; font: inherit; color: inherit; }
    .card img { width: 100%; height: 140px; object-fit: contain; display: block; background: #fafafa; border-radius: 8px; }
    .card span { display: block; margin-top: 0.55rem; word-break: break-word; }
    .empty { padding: 1.5rem; }
    dialog { border: 0; padding: 0; background: transparent; max-width: none; max-height: none; }
    dialog::backdrop { background: rgba(20, 20, 20, 0.72); }
    .frame { display: flex; flex-direction: column; align-items: center; gap: 0.75rem; }
    .frame img { max-width: calc(100vw - 3rem); max-height: calc(100vh - 5rem); object-fit: contain; background: #fff; border-radius: 12px; }
    .frame button { border: 0; border-radius: 999px; padding: 0.45rem 0.9rem; background: #fff; font: inherit; cursor: pointer; }
  </style>
</head>
<body>
  <h1>${escapeHtml(folderName)}</h1>
  ${cards}
  <dialog id="viewer">
    <div class="frame">
      <img id="viewer-image" alt="">
      <button type="button" id="close">Schließen</button>
    </div>
  </dialog>
  <script>
    const dialog = document.querySelector("#viewer");
    const image = document.querySelector("#viewer-image");
    for (const card of document.querySelectorAll(".card")) {
      card.addEventListener("click", () => {
        image.src = card.dataset.src;
        image.alt = card.dataset.title;
        dialog.showModal();
      });
    }
    document.querySelector("#close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  </script>
</body>
</html>
`;
}

function card(fileName: string): string {
  const title = path.parse(fileName).name;
  const src = encodeURIComponent(fileName);
  return `<button type="button" class="card" data-src="${escapeHtml(src)}" data-title="${escapeHtml(title)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(title)}"><span>${escapeHtml(title)}</span></button>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadEnvFile(): void {
  try {
    process.loadEnvFile(path.resolve(".env"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}
