# Seiten-Zuordnung für Screenshots — Design

Datum: 2026-07-23
Status: freigegeben, in Umsetzung

## Problem

Die Analyse in `prompt.js` ist richtungsabhängig (Investition „Du : Er/Sie", Bindungsstil
pro Seite, „Signale der anderen Person", Strategie für den User). Verwechselt das Modell,
wer wer ist, kippt die Auswertung ins Gegenteil. Die bisherige OCR
(`Tesseract.recognize` → `text.trim()`) wirft Position und Farbe der Sprechblasen weg und
macht aus dem Screenshot eine flache Textwurst ohne Zuordnung.

## Umfang

Nur Screenshots. Getippter Text und WhatsApp-`.txt`-Export bleiben unverändert (dort gibt es
keine Blasen; die Namen tragen die Zuordnung ohnehin).

## Lösung

### Ablauf (User)

- Im Screenshot-Tray ein Schalter: **Meine Nachrichten: [rechts] [links]** (Standard rechts).
- Beim „Text erkennen" wird jede Zeile zugeordnet und ein **beschrifteter Verlauf** ins
  Textfeld geschrieben (`Ich:` / `Gegenüber:`), sichtbar und editierbar, damit der User einen
  Fehlgriff vor der Analyse korrigieren kann.
- Der beschriftete Verlauf wird an vorhandenen Textinhalt **angehängt**, nicht ersetzt.

### Zuordnung

- **Position entscheidet.** Aus Tesseract die Bounding-Box jeder Zeile lesen, horizontalen
  Mittelpunkt relativ zur Bildbreite bestimmen: linke Hälfte → Gegenüber, rechte Hälfte →
  Ich (bzw. umgekehrt je Schalter). Eine Totzone in der Mitte (Standard 35–65 %) fängt
  zentrierte Deko (Datum, „Zugestellt", Reaktionen) als neutralen Kontext ab.
- **Farbe sichert ab, steuert nicht.** Aus einem Canvas die mittlere Helligkeit je Zeile
  messen. Sind die zwei Positionsgruppen farblich klar getrennt, bestätigt das die Zuordnung;
  wirken sie uneindeutig, ein dezenter Hinweis „bitte Verlauf prüfen". Kein per-Zeile-Zwang.
  Farbe ist der wackelige Teil (Dark Mode, Hintergrundbilder) — bleibt rein beratend; falls
  im Test mehr Lärm als Nutzen, wird sie entfernt, Position trägt allein.

### Technik

- OCR über **einen wiederverwendeten Worker** (`Tesseract.createWorker('deu+eng')`,
  `worker.recognize(file, {}, { blocks: true })`) statt pro Bild `Tesseract.recognize` —
  schneller im Stapel und liefert die Boxen (die Convenience-API tut das nicht).
- Reine, testbare Zuordnung in `public/seiten.js` (`klassifiziereZeilen`, `baueVerlauf`),
  im Browser als globale Funktionen, in Node via `module.exports` testbar.
- Farb-Abtastung bleibt browserseitig in `app.js` (Canvas), nicht unit-getestet.

### Prompt

`prompt.js` bekommt einen Abschnitt: Eingaben können mit `Ich:` (User) und `Gegenüber:`
(die andere Person) beschriftet sein; diese Zuordnung ist verbindlich. Fehlt sie, wird wie
bisher aus dem Kontext geschlossen.

## Mitgezogene Review-Fixe (Mehrfach-Upload)

Da `runShots` neu gebaut wird:
- A: beschrifteten Verlauf **anhängen** statt überschreiben.
- B: Tesseract-Totalausfall klar melden, Stapel **nicht** leeren; nur erfolgreiche Bilder
  entfernen, fehlgeschlagene zum erneuten Versuch behalten.
- C: gemeinsame `shotsBusy`-Sperre mit dem Datei-Upload (`handleTextFileSelect` mit Guard,
  bedingtes Re-enable).
- D: Fokus nach ▲▼× auf der betroffenen Zeile wiederherstellen.
- E: `aria-live` für Fortschritt und Warnung.
- F: Zeilen-Knöpfe während der OCR sichtbar gesperrt.

## Test & Risiko

- `test/seiten-zuordnung.test.mjs`: reine Positions-Zuordnung (Zeilen-Boxen → Ich/Gegenüber/
  Kontext) und `baueVerlauf`, ohne Browser.
- Risiko: Tesseracts Box-Daten. Abgesichert durch den Worker-Weg mit `{ blocks: true }`, der
  die Boxen laut Typdefinition garantiert liefert.
