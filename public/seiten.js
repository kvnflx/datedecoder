// Reine Seiten-Zuordnung für Chat-Screenshots. Keine DOM-/Browser-Abhängigkeit,
// damit test/seiten-zuordnung.test.mjs sie ohne Browser prüfen kann. Im Browser
// werden die Funktionen zu globalen Bezeichnern (klassischer <script>), in Node
// exportiert sie module.exports.

// Bringt die OCR-Zeilen in echte Lesereihenfolge: von oben nach unten nach der
// Oberkante (y0). Nötig, weil Tesseract bei Zwei-Spalten-Layouts (linke/rechte
// Bubbles) die Blöcke spaltenweise liefern kann statt zeilenweise verschränkt.
// Bei gleicher Höhe entscheidet die horizontale Position (links vor rechts).
function sortiereNachHoehe(zeilen) {
  return (zeilen || []).slice().sort((a, b) => {
    if (a.y0 !== b.y0) return a.y0 - b.y0;
    return (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2;
  });
}

// Ordnet jede OCR-Zeile ihrer Seite zu — RANDBASIERT: eine Sprechblase gehört zu der
// Seite, deren Rand sie berührt, unabhängig davon wie lang sie ist. Der Mittelpunkt
// taugt nicht: eine lange Blase reicht mit ihrer Mitte bis zur Bildmitte und würde
// sonst fälschlich als "Kontext" gelten.
//   zeilen: [{ text, x0, x1 }] — x0/x1 = linke/rechte Kante der Zeile in Bildpixeln
//   bildBreite: Breite des Screenshots in Pixeln
//   meineSeite: 'rechts' | 'links' — wo die eigenen Nachrichten stehen
//   mitteAnteil: wie ähnlich beide Randabstände sein müssen, damit eine Zeile als
//                zentrierter Kontext (Datum, Systemzeile) gilt — Anteil der Bildbreite
//                (Standard 0.15)
// Rückgabe: [{ text, seite: 'ich' | 'gegenueber' | 'kontext' }]
function klassifiziereZeilen(zeilen, bildBreite, meineSeite, mitteAnteil) {
  const grenze = typeof mitteAnteil === 'number' ? mitteAnteil : 0.15;
  const seitig = meineSeite === 'links' ? 'links' : 'rechts';
  const breite = bildBreite > 0 ? bildBreite : 1;

  return (zeilen || []).map((z) => {
    const abstandLinks = z.x0;               // Abstand der Zeile zum linken Bildrand
    const abstandRechts = breite - z.x1;     // Abstand zum rechten Bildrand
    const diff = Math.abs(abstandLinks - abstandRechts) / breite;

    let physisch;
    if (diff < grenze) physisch = 'mitte';   // beide Ränder ähnlich weit -> zentriert
    else if (abstandLinks < abstandRechts) physisch = 'links';
    else physisch = 'rechts';

    let seite;
    if (physisch === 'mitte') seite = 'kontext';
    else if (physisch === seitig) seite = 'ich';
    else seite = 'gegenueber';

    return { text: z.text, seite };
  });
}

// Baut aus den zugeordneten Zeilen einen beschrifteten Verlauf. Aufeinanderfolgende
// Zeilen derselben Seite gehören zur selben Gesprächswendung und werden zu einer
// Nachricht zusammengefasst. Kontextzeilen (Datum, "Zugestellt" o. Ä.) bleiben ohne
// Label erhalten, damit zeitliche Hinweise nicht verloren gehen.
function baueVerlauf(klassifizierte) {
  const zeilenAus = [];
  let aktSeite = null;
  let puffer = [];

  const flush = () => {
    if (!puffer.length) return;
    const label = aktSeite === 'ich' ? 'Ich' : 'Gegenüber';
    zeilenAus.push(label + ': ' + puffer.join(' '));
    puffer = [];
  };

  for (const z of klassifizierte || []) {
    const t = (z.text || '').trim();
    if (!t) continue;

    if (z.seite === 'kontext') {
      flush();
      aktSeite = null;
      zeilenAus.push(t);
      continue;
    }

    if (z.seite !== aktSeite) {
      flush();
      aktSeite = z.seite;
    }
    puffer.push(t);
  }
  flush();

  return zeilenAus.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sortiereNachHoehe, klassifiziereZeilen, baueVerlauf };
}
