// Reine Seiten-Zuordnung für Chat-Screenshots. Keine DOM-/Browser-Abhängigkeit,
// damit test/seiten-zuordnung.test.mjs sie ohne Browser prüfen kann. Im Browser
// werden die Funktionen zu globalen Bezeichnern (klassischer <script>), in Node
// exportiert sie module.exports.

// Bringt die OCR-Zeilen in echte Lesereihenfolge: von oben nach unten nach
// vertikaler Mitte. Nötig, weil Tesseract bei Zwei-Spalten-Layouts (linke/rechte
// Bubbles) die Blöcke spaltenweise liefern kann statt zeilenweise verschränkt.
// Bei gleicher Höhe entscheidet die horizontale Position (links vor rechts).
function sortiereNachHoehe(zeilen) {
  return (zeilen || []).slice().sort((a, b) => {
    const ay = (a.y0 + a.y1) / 2;
    const by = (b.y0 + b.y1) / 2;
    if (ay !== by) return ay - by;
    return (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2;
  });
}

// Ordnet jede OCR-Zeile ihrer Seite zu.
//   zeilen: [{ text, x0, x1 }] — x0/x1 = linke/rechte Kante der Zeile in Bildpixeln
//   bildBreite: Breite des Screenshots in Pixeln
//   meineSeite: 'rechts' | 'links' — wo die eigenen Nachrichten stehen
//   totzoneAnteil: Anteil der Bildbreite in der Mitte, der als Kontext gilt (Standard 0.30)
// Rückgabe: [{ text, seite: 'ich' | 'gegenueber' | 'kontext', rel }]
function klassifiziereZeilen(zeilen, bildBreite, meineSeite, totzoneAnteil) {
  const tot = typeof totzoneAnteil === 'number' ? totzoneAnteil : 0.3;
  const untenGrenze = 0.5 - tot / 2;
  const obenGrenze = 0.5 + tot / 2;
  const seitig = meineSeite === 'links' ? 'links' : 'rechts';

  return (zeilen || []).map((z) => {
    const mitte = (z.x0 + z.x1) / 2;
    const rel = bildBreite > 0 ? mitte / bildBreite : 0.5;

    let physisch;
    if (rel < untenGrenze) physisch = 'links';
    else if (rel > obenGrenze) physisch = 'rechts';
    else physisch = 'mitte';

    let seite;
    if (physisch === 'mitte') seite = 'kontext';
    else if (physisch === seitig) seite = 'ich';
    else seite = 'gegenueber';

    return { text: z.text, seite, rel };
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
