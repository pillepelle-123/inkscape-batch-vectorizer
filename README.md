# Inkscape Batch Vectorizer

CLI-Tool, das PNG- und JPG-Dateien über die Inkscape-Funktion **Bitmap nachzeichnen** (Modus Mehrfarbig, Erkennung nach Farben) in SVG-Dateien umwandelt.

Getestet mit Inkscape 1.4.4 und Node.js 24.

## Voraussetzungen

- [Node.js](https://nodejs.org/) 24 oder neuer
- Inkscape 1.4.4. Unter Windows wird `inkscape.com` verwendet.

Das Programm sucht Inkscape zuerst unter dem Pfad aus der Config, dann als `inkscape.com` im PATH und zuletzt unter `C:\Program Files\Inkscape\bin\inkscape.com`.

## Installation

```bash
npm install
npm run build
```

Während der Entwicklung lässt sich das Tool ohne Build-Schritt starten:

```bash
npm run dev
```

## Verwendung

Lege die Rasterdateien in den Input-Ordner und starte:

```bash
node dist/cli.js
```

Ohne Dateiname wird die oberste Ebene des Input-Ordners verarbeitet. Unterordner werden nicht durchsucht. Mit einem Dateinamen wird nur diese eine Datei verarbeitet. Der Name ist relativ zum Input-Ordner; ein absoluter Pfad ist ebenfalls möglich.

```bash
node dist/cli.js logo.png
node dist/cli.js --config C:\pfad\vectorizer.config.json
node dist/cli.js logo.png --simplify strong
```

Nach `npm run build` steht derselbe Einstieg über `npx inkscape-vectorize` zur Verfügung.

Für jede fertige Datei erscheint eine Zeile:

```text
[ 3/12] OK      logo.png -> logo.svg (4.8 s, scans=5, smooth=nein, 38 KB)
[ 4/12] FEHLER  foto.jpg: SVG enthält keine Vektorpfade
[ 5/12] SKIP    icon.png (existiert bereits)
```

Am Ende steht eine Zusammenfassung. Schlägt mindestens eine Datei fehl, ist der Exit-Code 1. Der Batch läuft bei einem Fehler weiter. Sind keine passenden Dateien vorhanden, endet das Programm mit Exit-Code 0.

## Konfiguration

Die Standarddatei ist `vectorizer.config.json` im aktuellen Arbeitsverzeichnis. Eine Vorlage liegt in `vectorizer.config.example.json`. Relative Pfade gelten relativ zur Config-Datei. Zahlen in JSON verwenden einen Punkt als Dezimaltrennzeichen, zum Beispiel `1.34`.

| Feld | Bedeutung |
| --- | --- |
| `inputDir` | Ordner mit den Rasterdateien |
| `outputDir` | Ablage der SVG-Dateien, wird bei Bedarf angelegt |
| `extensions` | Erlaubte Endungen, Groß-/Kleinschreibung egal. Standard: `.png`, `.jpg`, `.jpeg` |
| `overwrite` | `true` überschreibt vorhandene SVGs, `false` überspringt sie. Eine fehlgeschlagene Datei ersetzt eine vorhandene SVG nicht. |
| `concurrency` | Anzahl gleichzeitiger Inkscape-Prozesse, mindestens 1. Standard: 2 |
| `timeoutSeconds` | Zeitlimit pro Datei |
| `inkscapePath` | Pfad zu `inkscape.com`, oder `null` für die automatische Suche |
| `trace.scans` | Anzahl der Farb-Scans, Ganzzahl von 2 bis 256, oder `"auto"` |
| `trace.smooth` | Glätten: `true`, `false` oder `"auto"` |
| `trace.stack` | Stapeln |
| `trace.removeBackground` | `true` macht nur echte transparente Bereiche transparent. `false` lässt den Hintergrund stehen, auch wenn das Bild Transparenz hatte |
| `trace.speckles` | Flecken unterdrücken, Ganzzahl von 0 bis 1000 |
| `trace.smoothCorners` | Ecken glätten, von 0 bis 1.34 |
| `trace.optimize` | Optimieren, von 0 bis 5 |
| `autoColors.minColorDistance` | Ab diesem Farbabstand (ΔE2000) gelten zwei Töne als dieselbe Farbe. Standard: 10 |
| `autoColors.minColorShare` | Farben mit geringerem Pixelanteil zählen als Ausreißer. Standard: 0.005 |
| `simplify.level` | `off`, `light`, `medium` oder `strong`. Standard: `off` |
| `simplify.maxColors` | Obergrenze für die Scan-Anzahl. `null` übernimmt den Wert der Stufe |
| `simplify.medianSize` | Median-Filter vor dem Nachzeichnen, 0 oder eine ungerade Zahl von 1 bis 15. `null` übernimmt den Wert der Stufe |
| `simplify.svgo` | SVG nach dem Nachzeichnen verlustarm komprimieren. Standard: `true` |
| `simplify.svgoPrecision` | Nachkommastellen der SVG-Koordinaten. `null` übernimmt den Wert der Stufe |

`"auto"` bei `scans` zählt deutliche Farben im Bild. Hat das Bild einen transparenten Hintergrund und ist `removeBackground` an, kommt ein Scan für die Schlüsselfarbe dazu. `"auto"` bei `smooth` ist bei JPEG immer an und bei PNG erst, wenn mindestens 5 % der Pixel als Ausreißer gelten.

`removeBackground: true` färbt transparente Pixel (Alpha unter 128) vor dem Nachzeichnen in eine Farbe, die im Motiv nicht vorkommt, und entfernt danach nur die Pfade dieser Farbe. Weiße und helle Motivflächen, zum Beispiel Pupillen, bleiben erhalten. Bilder ohne Transparenz, auch JPEG, behalten ihren Hintergrund. Weiche Schatten und halbtransparente Kanten werden an der Schwelle Alpha 128 zu harten Kanten. Beim Stapeln läge unter der Schlüsselfarbe eine deckende Fläche; deshalb zeichnet das Tool Bilder mit Transparenz ohne Stapeln nach. Die Fortschrittszeile zeigt dann `transparent, stack=aus (Transparenz)`.

Die Stufe `--simplify` verstärkt `speckles`, `optimize` und `smoothCorners` relativ zu den Werten in der Config und begrenzt sie auf die erlaubten Bereiche. Ein CLI-Aufruf überschreibt die Stufe der Config:

```bash
node dist/cli.js --simplify medium
```

| Stufe | maxColors | Median | speckles | optimize | smoothCorners | SVGO-Nachkommastellen |
| --- | --- | --- | --- | --- | --- | --- |
| `off` | keine Obergrenze | – | unverändert | unverändert | unverändert | 2 |
| `light` | 16 | – | ×1,5 | +0,25 | +0,05 | 2 |
| `medium` | 8 | 3 | ×2 | +0,5 | +0,1 | 1 |
| `strong` | 4 | 5 | ×3 | +1,0 | +0,2 | 1 |

`maxColors`, `medianSize` und `svgoPrecision` in der Config haben Vorrang vor der Stufe. Die Scan-Anzahl bleibt mindestens 2.

Der Erkennungsmodus ist fest **Farben**. Einmaliger Scan und Pixelkunst werden nicht verwendet. Zwei Eingabedateien mit demselben Basisnamen (`logo.png` und `logo.jpg`) würden dieselbe SVG erzeugen und werden vor dem Start abgelehnt.

Die ausgegebene SVG enthält nur die Vektorpfade. Die ursprüngliche Bitmap wird entfernt.

## Hinweise zu Inkscape 1.4.4

Auf diesem System wurden die Trace-Parameter mit einer kleinen Testgrafik geprüft:

- `1.34` und `0.2` kommen als Punkt-Dezimalzahl an. `smoothCorners` 0, 1 und 1.34 erzeugen unterschiedliche Pfade, ebenso `optimize` 0 und 5.
- `stack` verändert die Pfadgeometrie. `true` und `false` liefern unterschiedliche Pfade. `clipPath`-Elemente schreibt diese CLI-Version dabei nicht.
- Mehrere Inkscape-Prozesse können parallel laufen. Bei drei Testdateien und `concurrency: 2` war die Gesamtdauer kürzer als die Summe der Einzelzeiten.
- Beim Stapeln deckt die unterste Ebene das ganze Bild. Eine Schlüsselfarbe lässt sich dort nicht entfernen, ohne den Hintergrund deckend zu machen. Bilder mit Transparenz werden deshalb ohne Stapeln nachgezeichnet.
- An `b3_9slice_Rand_oben.png` und `b1_Punktgirlande.png` mit `"scans": "auto"` (9 Farben, `smooth` aus) wurden die Stufen verglichen. Die SVG behält die `viewBox`. Größen: off 95 KB und 43 KB, light 91 KB und 40 KB, medium 31 KB und 25 KB, strong 3,2 KB und 8,8 KB. `light` senkt die Scan-Zahl hier nicht, weil 9 unter der Obergrenze 16 liegt.
