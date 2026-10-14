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

## Laufprotokoll

Jeder Lauf schreibt ein Protokoll in PostgreSQL, sobald `DATABASE_URL` in `.env` steht. Die Datenbank `inkscape-batch-vectorizer` und die Tabellen legt das Tool beim Start selbst an.

`batch_runs` enthält einen Eintrag pro Lauf. Die `id` ist die Batch-Nummer, dazu Zeit, Dauer, die aufgelösten Ordner, die Config als `jsonb` und die Zähler. `batch_assets` enthält einen Eintrag pro Bild, verknüpft über `batch_id`. Dort stehen Status (`ok`, `skipped`, `error`), Dauer, Ausgabedateigröße und die Werte aus der Fortschrittszeile, unter anderem Scans, Glätten, Transparenz, `speckles`, Median und die Farbzahl im Flächen-Modus.

Die Zusammenfassung nennt die Batch-Nummer, zum Beispiel `Batch 17`. Kann das Protokoll nicht geschrieben werden, bricht der Lauf ab. Bilder, die schon in Arbeit sind, werden noch fertig. Es startet kein weiteres, und der Prozess endet mit Code 1.

Für jede fertige Datei erscheint eine Zeile:

```text
[ 3/12] OK      logo.png -> logo.svg (4.8 s, scans=5, smooth=nein, 38 KB)
[ 4/12] FEHLER  foto.jpg: SVG enthält keine Vektorpfade
[ 5/12] SKIP    icon.png (existiert bereits)
```

Am Ende steht eine Zusammenfassung mit der Batch-Nummer. Schlägt mindestens eine Datei fehl, ist der Exit-Code 1. Der Batch läuft bei einem Fehler weiter. Sind keine passenden Dateien vorhanden, endet das Programm mit Exit-Code 0 und schreibt trotzdem einen Lauf mit den Zählern 0.

## Konfiguration

Die Standarddatei ist `vectorizer.config.json` im aktuellen Arbeitsverzeichnis. Eine Vorlage liegt in `vectorizer.config.example.json`. Relative Pfade gelten relativ zur Config-Datei. Zahlen in JSON verwenden einen Punkt als Dezimaltrennzeichen, zum Beispiel `1.34`. Unbekannte Schlüssel, etwa Hinweiszeilen, werden ignoriert.

`inputDir`, `outputDir` und das Objekt `trace` sind Pflicht. Alle anderen Blöcke haben Defaults, wenn sie fehlen.

### `inputDir`

- **Wirkung:** Ordner, aus dem die Rasterdateien gelesen werden. Es wird nur die oberste Ebene verarbeitet.
- **Werte:** Nicht leerer Pfad. Pflichtfeld, kein Default.
- **Dateigröße:** Kein Einfluss. Bestimmt nur, welche Dateien verarbeitet werden.

### `outputDir`

- **Wirkung:** Ordner für die SVG-Dateien. Er wird bei Bedarf angelegt. Der Basisname der Eingabe bleibt erhalten, die Endung wird `.svg`.
- **Werte:** Nicht leerer Pfad. Pflichtfeld, kein Default. Der Ordner sollte nicht innerhalb von `inputDir` liegen.
- **Dateigröße:** Kein Einfluss.

### `extensions`

- **Wirkung:** Welche Dateiendungen im Input-Ordner verarbeitet werden. Die Groß-/Kleinschreibung ist egal.
- **Werte:** Liste mit mindestens einem Eintrag der Form `.png`. Default, wenn das Feld fehlt: `.png`, `.jpg`, `.jpeg`.
- **Dateigröße:** Kein Einfluss.

### `overwrite`

- **Wirkung:** `true` ersetzt eine vorhandene SVG. `false` überspringt sie (`SKIP`). Eine fehlgeschlagene Datei ersetzt eine vorhandene SVG nicht.
- **Werte:** `true` oder `false`. Default: `true`.
- **Dateigröße:** Kein Einfluss.

### `concurrency`

- **Wirkung:** Wie viele Inkscape-Prozesse gleichzeitig laufen.
- **Werte:** Ganzzahl ab 1, kein festes Maximum. Default: `2`. Empfohlen: `2`. Höhere Werte verkürzen die Gesamtdauer, belasten aber CPU und Speicher stärker.
- **Dateigröße:** Kein Einfluss.

### `timeoutSeconds`

- **Wirkung:** Zeitlimit pro Inkscape-Aufruf. Bei transparenten Bildern gibt es zwei Aufrufe (Farben und Silhouette); das Limit gilt für jeden einzeln. Wird es überschritten, endet diese Datei mit Fehler.
- **Werte:** Ganzzahl ab 1, kein festes Maximum. Default: `120`. Empfohlen: `120` für Sticker; bei sehr großen Bildern höher.
- **Dateigröße:** Kein Einfluss.

### `inkscapePath`

- **Wirkung:** Pfad zu `inkscape.com` (Windows) bzw. `inkscape`. `null` sucht zuerst im PATH, unter Windows danach unter `C:\Program Files\Inkscape\bin\inkscape.com`.
- **Werte:** Nicht leerer Pfad oder `null`. Default: `null`.
- **Dateigröße:** Kein Einfluss.

### `trace.scans`

- **Wirkung:** Anzahl der Farben, die Inkscape beim Nachzeichnen unterscheidet (Modus Farben). Mehr Scans trennen mehr Farbtöne. `"auto"` zählt deutliche Farben im Bild. Hat das Bild Transparenz und ist `removeBackground` aus, kommt ein Scan für die weiße Hintergrundfläche dazu. Mit Silhouette (`removeBackground` an) kommt dieser Scan nicht dazu. `simplify.maxColors` und `simplify.level` können die Zahl danach begrenzen; mindestens bleiben 2 Scans.
- **Werte:** Ganzzahl von 2 bis 256, oder `"auto"`. Pflichtfeld, kein Default. Empfohlen: `"auto"`.
- **Dateigröße:** Mehr Scans erzeugen mehr Farbflächen und meist eine größere SVG. Weniger Scans fassen Farben zusammen und machen die Datei kleiner, verlieren aber Farbunterschiede.

### `trace.smooth`

- **Wirkung:** Entspricht „Glätten“ in Inkscape. `true` glättet Kanten und eignet sich für Fotos und weiche Verläufe. `false` behält härtere Kanten, passend zu gezeichneten Stickern. `"auto"` ist bei JPEG immer an und bei PNG erst, wenn mindestens 5 % der Pixel als Farbausreißer gelten.
- **Werte:** `true`, `false` oder `"auto"`. Pflichtfeld, kein Default. Empfohlen für gezeichnete Sticker: `"auto"` oder `false`.
- **Dateigröße:** Meist gering. Glätten kann Knoten verschieben; die Datei wird dadurch nicht zuverlässig kleiner oder größer.

### `trace.stack`

- **Wirkung:** Stapeln. `true` legt die Farbflächen übereinander, sodass die untere Ebene Lücken zwischen den oberen füllt. `false` zeichnet jede Farbe als eigene Fläche mit Löchern für die Nachbarfarben; an den Kanten kann der Hintergrund durchscheinen („Abblättern“). Bei transparenten Bildern mit `removeBackground: true` bleibt das Stapeln an; der transparente Bereich wird über die Silhouette ausgeschnitten.
- **Werte:** `true` oder `false`. Pflichtfeld, kein Default. Empfohlen: `true`.
- **Dateigröße:** Die Pfade werden anders aufgebaut. Mit Stapeln sind die unteren Ebenen oft großflächiger, die Datei kann etwas größer werden. Dafür bleiben Farbflächen geschlossen.

### `trace.removeBackground`

- **Wirkung:** `true` macht bei PNG mit Transparenz nur den transparenten Bereich transparent. Transparente Pixel (Alpha unter 128) werden vorher mit der Randfarbe des Motivs gefüllt, die Farben werden mit Stapeln nachgezeichnet, und eine zweite Zeichnung des Alpha-Kanals wird als `clipPath` darübergelegt. Weiße und helle Flächen innerhalb des Motivs, zum Beispiel Pupillen, bleiben erhalten. `false` lässt den Hintergrund als deckende Fläche stehen, auch wenn das PNG Transparenz hatte. JPEG und Bilder ohne Transparenz behalten ihren Hintergrund in beiden Fällen. Weiche Schatten werden an Alpha 128 zu harten Kanten. An Inkscape wird `removeBackground` immer als `false` übergeben; die Transparenz entsteht über die Silhouette.
- **Werte:** `true` oder `false`. Pflichtfeld, kein Default. Empfohlen: `true` für Sticker mit transparentem Hintergrund, `false` für deckende Bilder und JPEG.
- **Dateigröße:** Der zusätzliche `clipPath` macht die SVG etwas größer. Dafür entfällt die Hintergrundfläche. Transparente Bilder brauchen etwa doppelt so lange, weil Inkscape zweimal läuft.

### `trace.speckles`

- **Wirkung:** „Flecken unterdrücken“ in Inkscape. Zusammenhängende Flächen, die kleiner als dieser Wert (in Pixeln) sind, werden verworfen. Ein hoher Wert entfernt feine Textur und kleine Details, auch Glanzpunkte in Augen, wenn sie unter der Schwelle liegen. `"auto"` sucht in voller Auflösung kleine, kompakte Flächen mit starkem Kontrast zur Umgebung und setzt den Wert auf 80 % der kleinsten solchen Fläche, höchstens `autoDetail.maxSpeckles`. Gibt es keine solche Fläche, gilt die Obergrenze. Ein automatischer Wert ist endgültig: `simplify.level` multipliziert ihn nicht. Eine feste Zahl wird von der Stufe multipliziert (`light` ×1,5, `medium` ×2, `strong` ×3), begrenzt auf 0 bis 1000.
- **Werte:** Ganzzahl von 0 bis 1000, oder `"auto"`. Pflichtfeld, kein Default. Empfohlen für diesen Stickersatz: `25` bis `30`. `"auto"` ist eine Option; im Vergleich wurde sie körniger oder gröber als die festen Werte.
- **Dateigröße:** Höher entfernt mehr kleine Pfade und macht die SVG kleiner. `0` behält auch winzige Flecken und macht die Datei oft deutlich größer.

### `trace.smoothCorners`

- **Wirkung:** „Ecken glätten“ in Inkscape. Höhere Werte runden Ecken stärker ab. Die Stufe addiert bei einer festen Zahl `0.05` (`light`), `0.1` (`medium`) oder `0.2` (`strong`), begrenzt auf 0 bis 1.34.
- **Werte:** Zahl von 0 bis 1.34. Pflichtfeld, kein Default. Empfohlen: `1.00` bis `1.34`.
- **Dateigröße:** Stärkeres Glätten kann Knoten zusammenziehen und die Datei etwas verkleinern. Der Effekt ist kleiner als bei `speckles` oder `scans`.

### `trace.optimize`

- **Wirkung:** „Optimieren“ in Inkscape. Das ist nicht SVGO. Höhere Werte vereinfachen die Pfade stärker (weniger Knoten). Die Stufe addiert bei einer festen Zahl `0.25` (`light`), `0.5` (`medium`) oder `1.0` (`strong`), begrenzt auf 0 bis 5. In der Fortschrittszeile erscheint dieser Wert nicht; dort steht nur die Scan-Zahl und, falls automatisch, `speckles` und `median`.
- **Werte:** Zahl von 0 bis 5. Pflichtfeld, kein Default. Empfohlen: `2.000` bis `4.500`.
- **Dateigröße:** Höher ergibt meist weniger Knoten und eine kleinere SVG. Feine Konturen können dabei weicher oder gröber werden.

### `autoColors.minColorDistance`

- **Wirkung:** Nur für `"auto"` bei `scans` und `smooth`. Ab diesem Farbabstand (ΔE2000) gelten zwei Töne als dieselbe Farbe. Ein höherer Wert fasst mehr ähnliche Töne zusammen und senkt die automatische Scan-Zahl.
- **Werte:** Zahl von 0 bis 100. Default: `10`. Empfohlen: `10`.
- **Dateigröße:** Nur indirekt, wenn `scans` auf `"auto"` steht. Höher kann weniger Scans und damit eine kleinere SVG ergeben.

### `autoColors.minColorShare`

- **Wirkung:** Nur für die Farbanalyse. Farben mit geringerem Anteil an den deckenden Pixeln zählen als Ausreißer und erhöhen die Scan-Zahl nicht. Ab 5 % Ausreißeranteil schaltet `"auto"` bei `smooth` für PNG das Glätten ein.
- **Werte:** Zahl von 0 bis 1. Default: `0.005` (0,5 %). Empfohlen: `0.005`.
- **Dateigröße:** Nur indirekt über die automatische Scan-Zahl. Ein höherer Anteil lässt mehr kleine Farben weg und kann die SVG verkleinern.

### `autoDetail.maxSpeckles`

- **Wirkung:** Obergrenze für `trace.speckles`, wenn der Wert `"auto"` ist. Dieselbe Zahl gilt, wenn das Bild keine Glanzpunkte hat. Bei einer festen `speckles`-Zahl hat das Feld keine Wirkung.
- **Werte:** Ganzzahl von 0 bis 1000. Default: `100`. Empfohlen: `100`.
- **Dateigröße:** Nur bei automatischen `speckles`. Eine höhere Obergrenze lässt mehr kleine Flächen stehen, wenn keine Glanzpunkte gefunden werden, und die SVG wird größer. Eine niedrigere Obergrenze deckelt den Wert und hält die Datei kleiner, kann aber Glanzpunkte abschneiden, wenn die berechnete Zahl darüber liegt.

### `flatColors.mode`

- **Wirkung:** Flächen-Modus für Motive mit schwarzem Umriss und wenigen einfarbigen Flächen. `off` lässt jedes Bild durch die bisherige Pipeline. `flat` erzwingt den Flächen-Modus. `auto` entscheidet pro Bild: Kantenpixel zählen nicht mit, die übrigen deckenden Pixel werden in Lab zu einer Palette zusammengefasst. Ein Flächen-Motiv hat höchstens `maxColors` Farben, einen mittleren Farbabstand unter 3,4 und weniger als 3 % Pixel, die weiter als ΔE 8 von ihrer Farbe entfernt sind. Jede Farbe wird als eigene Maske nachgezeichnet. Die größte Fläche ist der Grund, die dunkelste liegt oben. Andere Flächen wachsen um `dilate` Pixel, aber nur in die Umrissfarbe, damit kein fremder Saum sichtbar wird. `scans`, `smooth`, `stack` und der Median haben in diesem Modus keine Wirkung. `removeBackground` entscheidet weiter, ob transparente Bereiche ausgeschnitten werden. Die Vereinfachungsstufe gilt weiter für `speckles`, `optimize` und `smoothCorners`.
- **Werte:** `off`, `flat` oder `auto`. Default: `off`. Empfohlen: `auto`, wenn Doodles und Aquarelle in einem Lauf gemischt sind. `flat`, wenn ein Motiv sicher aus Flächen besteht.
- **Dateigröße:** Bei den geprüften Doodles deutlich kleiner als die bisherige Pipeline, weil jede Farbe ein Pfad ist und keine Textur mitgezeichnet wird.

### `flatColors.colorDistance`

- **Wirkung:** Zwei Palettentöne unter diesem ΔE2000 gelten als eine Farbe. Höher fasst ähnliche Pastelltöne zusammen, niedriger behält sie getrennt.
- **Werte:** Zahl von 0 bis 100. Default: `12`. Empfohlen: `12`.
- **Dateigröße:** Höher kann Farben zusammenlegen und die SVG verkleinern. Zu hoch verschluckt kleine Flächen wie eine blasse Spirale.

### `flatColors.maxColors`

- **Wirkung:** Nur für `mode: "auto"`. Mehr Farben als diese Zahl gelten nicht als Flächen-Motiv, das Bild läuft durch die bisherige Pipeline. Im erzwungenen Modus `flat` begrenzt das Feld die Palette nicht.
- **Werte:** Ganzzahl von 2 bis 32. Default: `12`. Empfohlen: `12`.
- **Dateigröße:** Nur darüber, ob der Flächen-Modus greift. Der Flächen-Modus selbst ist bei Doodles kleiner.

### `flatColors.dilate`

- **Wirkung:** Um wie viele Pixel eine Farbfläche unter den Umriss wächst. Sie wächst nur in Pixel der dunkelsten Farbe, nie in eine Nachbarfarbe. Der Umriss selbst wird nicht erweitert und zuletzt gezeichnet.
- **Werte:** Ganzzahl von 0 bis 8. Default: `2`. Empfohlen: `2`.
- **Dateigröße:** Kaum. Ein höherer Wert verändert die Überlappung unter dem Umriss, nicht die Zahl der Pfade.

Grenzen von `auto`: Verläufe und Wasserfarben-Textur bleiben bei der bisherigen Pipeline. An `b2_Botanik_Seitenornament_rechts.png` (Aquarell ohne schwarzen Umriss) wird der erzwungene Flächen-Modus zu flächigen Bändern, die weichen Übergänge in Beige und Salbeigrün gehen verloren. `auto` erkennt dieses Bild nicht als Fläche (6 Farben, mittlerer Abstand 4,7, 7,8 % unerklärt). Löwe und Clown ebenfalls nicht.

Prüfung mit `auto` an sechs Pastell-Doodles, jeweils gegen die bisherige Pipeline mit 8 Scans, `smooth` aus, Median 0, `speckles` 30: alle sechs wurden als Fläche erkannt. Das Notizfeld hat 5 Farben (Weiß, Schwarz, Rosa, Gelb, Blau), ohne rosa Saum am Gelb. Dateigrößen Fläche gegen bisher: Notizfeld links 33 statt 61 KB, Notizfeld oben 36 statt 288 KB, Briefumschlag 24 statt 261 KB, Binderklammer 11 statt 122 KB, Banner 5 statt 995 KB, Tape 9 statt 381 KB. Ein Trace dauert dort etwa 3 bis 8 Sekunden, weil jede Farbe ein eigener Inkscape-Aufruf ist.

### `simplify.level`

- **Wirkung:** Stufe, die mehrere Werte gemeinsam verschiebt. Sie begrenzt die Scans (`maxColors`), multipliziert feste `speckles`, addiert auf `optimize` und `smoothCorners` und setzt den Default für Median und SVGO-Nachkommastellen. `"auto"` bei `speckles` oder `medianSize` wird von der Stufe nicht verändert. Die CLI-Option `--simplify` überschreibt nur dieses Feld. Die Tabelle der Stufen steht weiter unten.
- **Werte:** `off`, `light`, `medium` oder `strong`. Default: `off`. Empfohlen: `off`, wenn die Trace-Werte in der Config schon stimmen; `light`, `medium` oder `strong`, wenn die Datei kleiner werden soll.
- **Dateigröße:** `off` lässt feste Trace-Werte unverändert. `light`, `medium` und `strong` machen die SVG in dieser Reihenfolge kleiner, weil sie mehr Farben zusammenfassen und Pfade stärker vereinfachen. Feine Details gehen dabei verloren.

### `simplify.maxColors`

- **Wirkung:** Obergrenze für `trace.scans`, nachdem `"auto"` aufgelöst wurde. `null` übernimmt die Obergrenze der Stufe: keine bei `off`, 16 bei `light`, 8 bei `medium`, 4 bei `strong`. Die Zahl bleibt mindestens 2.
- **Werte:** Ganzzahl von 2 bis 256, oder `null`. Default: `null`. Empfohlen: `null`, solange die Stufe passen soll.
- **Dateigröße:** Eine niedrigere Obergrenze begrenzt die Scans und macht die SVG kleiner. `null` bei Stufe `off` begrenzt nicht.

### `simplify.medianSize`

- **Wirkung:** Median-Filter auf dem Rasterbild, bevor Inkscape nachzeichnet. Er glättet Textur (Wasserfarbe, Körnung), lässt kompakte Flächen ab etwa 3 bis 4 Pixeln Breite aber meist stehen. `0` schaltet den Filter aus. `"auto"` misst die Textur und wählt 0, 3 oder 5, aber nur so groß, dass erkannte Glanzpunkte mindestens 70 % ihrer Fläche behalten. `null` übernimmt den Wert der Stufe: 0 bei `off` und `light`, 3 bei `medium`, 5 bei `strong`. Ein automatischer Wert hat Vorrang vor der Stufe.
- **Werte:** `0`, eine ungerade Ganzzahl von 1 bis 15, `"auto"` oder `null`. Default: `null`. Empfohlen für texturierte Sticker: `3`. `"auto"` ist eine Option; im Vergleich blieb `3` ruhiger.
- **Dateigröße:** Ein stärkerer Filter entfernt feine Flecken schon vor dem Trace. Die SVG wird dadurch oft kleiner. `0` behält die Textur und kann die Datei deutlich vergrößern, besonders zusammen mit niedrigem `speckles`.

### `simplify.svgo`

- **Wirkung:** Nach dem Nachzeichnen läuft [SVGO](https://github.com/svg/svgo) mit `preset-default` über die SVG: überflüssiges Markup fällt weg, Pfadkoordinaten werden gerundet. Das ist unabhängig von `trace.optimize`. `false` überspringt diese Komprimierung. Bei einer Silhouette wird der `clipPath` auch dann eingesetzt; ohne `svgo` läuft nur dieses Zuschneiden, nicht das Preset.
- **Werte:** `true` oder `false`. Default: `true`. Empfohlen: `true`.
- **Dateigröße:** `true` macht die SVG kleiner, ohne die Formen stark zu verändern. `false` lässt die Inkscape-Ausgabe weitgehend stehen und ergibt größere Dateien.

### `simplify.svgoPrecision`

- **Wirkung:** Wie viele Nachkommastellen SVGO in den Pfadkoordinaten behält. Höher bleibt näher an der Inkscape-SVG. Niedriger rundet stärker; benachbarte Punkte können zusammenfallen. Wirkt nur, wenn `simplify.svgo` an ist. `null` übernimmt den Wert der Stufe: 2 bei `off` und `light`, 1 bei `medium` und `strong`.
- **Werte:** Ganzzahl von 0 bis 8, oder `null`. Default: `null`. Empfohlen: `null` oder `2`. `1` oder `0`, wenn die Dateigröße wichtiger ist als die letzte Kantengenauigkeit.
- **Dateigröße:** Niedriger rundet stärker und macht die SVG kleiner. Höher erhält längere Zahlen und ergibt größere Dateien. Der Unterschied ist meist kleiner als der von `speckles`, `scans` oder der Vereinfachungsstufe.

Die Stufe `--simplify` überschreibt nur `simplify.level`. Sie verstärkt feste `speckles`, `optimize` und `smoothCorners` und setzt die Defaults für Scans, Median und SVGO-Nachkommastellen:

```bash
node dist/cli.js --simplify medium
```

| Stufe | maxColors | Median | speckles | optimize | smoothCorners | SVGO-Nachkommastellen |
| --- | --- | --- | --- | --- | --- | --- |
| `off` | keine Obergrenze | – | unverändert | unverändert | unverändert | 2 |
| `light` | 16 | – | ×1,5 | +0,25 | +0,05 | 2 |
| `medium` | 8 | 3 | ×2 | +0,5 | +0,1 | 1 |
| `strong` | 4 | 5 | ×3 | +1,0 | +0,2 | 1 |

`maxColors`, `medianSize` und `svgoPrecision` in der Config haben Vorrang vor der Stufe. Die Scan-Anzahl bleibt mindestens 2. Ein automatischer Median hat Vorrang vor der Stufe.

Vergleich an Löwe, Clown, Elefant, Dompteur, Robbe, Karussellpferd und zwei flachen Assets, jeweils `speckles` 25 mit `medianSize` 3 gegen `"auto"`: Beim Löwen bleiben die Pupillen in beiden Varianten erhalten. Die Automatik setzt dort `speckles` 8 und `median` 3, die SVG wird mit 473 KB etwas größer als die 422 KB der festen Werte. Beim Clown findet sie keine kleinen Glanzpunkte und nimmt die Obergrenze 100, die Datei wird gröber (335 statt 366 KB). Beim Dompteur fällt `speckles` auf 6 und der Median auf 0, die SVG wächst von 838 KB auf 1650 KB und das Fell wird körniger. Deshalb bleibt `"auto"` eine Option. Für diesen Stickersatz sind `speckles` 25 und `medianSize` 3 die besseren festen Werte.

Der Erkennungsmodus ist fest **Farben**. Einmaliger Scan und Pixelkunst werden nicht verwendet. Zwei Eingabedateien mit demselben Basisnamen (`logo.png` und `logo.jpg`) würden dieselbe SVG erzeugen und werden vor dem Start abgelehnt.

Die ausgegebene SVG enthält nur die Vektorpfade. Die ursprüngliche Bitmap wird entfernt.

## Hinweise zu Inkscape 1.4.4

Auf diesem System wurden die Trace-Parameter mit einer kleinen Testgrafik geprüft:

- `1.34` und `0.2` kommen als Punkt-Dezimalzahl an. `smoothCorners` 0, 1 und 1.34 erzeugen unterschiedliche Pfade, ebenso `optimize` 0 und 5.
- `stack` verändert die Pfadgeometrie. `true` und `false` liefern unterschiedliche Pfade. `clipPath`-Elemente schreibt diese CLI-Version dabei nicht.
- Mehrere Inkscape-Prozesse können parallel laufen. Bei drei Testdateien und `concurrency: 2` war die Gesamtdauer kürzer als die Summe der Einzelzeiten.
- Beim Stapeln füllt die untere Ebene Lücken zwischen den Farbflächen. Transparente Bilder behalten das Stapeln; der transparente Bereich wird über eine Silhouette aus dem Alpha-Kanal ausgeschnitten.
- An `b3_9slice_Rand_oben.png` und `b1_Punktgirlande.png` mit `"scans": "auto"` (9 Farben, `smooth` aus) wurden die Stufen verglichen. Die SVG behält die `viewBox`. Größen: off 95 KB und 43 KB, light 91 KB und 40 KB, medium 31 KB und 25 KB, strong 3,2 KB und 8,8 KB. `light` senkt die Scan-Zahl hier nicht, weil 9 unter der Obergrenze 16 liegt.
