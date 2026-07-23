import { test } from 'node:test';
import assert from 'node:assert/strict';
import seiten from '../public/seiten.js';

const { sortiereNachHoehe, klassifiziereZeilen, baueVerlauf } = seiten;

// Bildbreite 1000.
const BREITE = 1000;
const linksZeile = { text: 'von links', x0: 50, x1: 300 };
const rechtsZeile = { text: 'von rechts', x0: 700, x1: 950 };
const mitteZeile = { text: '12:03', x0: 420, x1: 580 }; // beide Ränder gleich weit -> Kontext

test('rechts = ich, links = gegenueber, wenn ich rechts bin', () => {
  const r = klassifiziereZeilen([rechtsZeile, linksZeile], BREITE, 'rechts');
  assert.equal(r[0].seite, 'ich');
  assert.equal(r[1].seite, 'gegenueber');
});

test('Schalter kippt die Zuordnung: wenn ich links bin, ist links = ich', () => {
  const r = klassifiziereZeilen([rechtsZeile, linksZeile], BREITE, 'links');
  assert.equal(r[0].seite, 'gegenueber');
  assert.equal(r[1].seite, 'ich');
});

test('zentrierte Zeile (Datum/Uhrzeit) landet als Kontext', () => {
  const r = klassifiziereZeilen([mitteZeile], BREITE, 'rechts');
  assert.equal(r[0].seite, 'kontext');
});

// Regression: der eigentliche Vertausch-Fehler. Eine LANGE Blase reicht mit ihrer
// Mitte bis nahe der Bildmitte. Randbasiert muss sie trotzdem korrekt zugeordnet
// werden — nicht als Kontext fallengelassen.
test('lange linke Nachricht bleibt gegenueber, wird nicht zu Kontext', () => {
  // Handy 1080 px, linke Blase reicht bis 74 % der Breite (Mitte bei rel 0.39).
  const lang = { text: 'oh man das kenn ich, bei mir ist grad auch echt viel los', x0: 44, x1: 800 };
  const r = klassifiziereZeilen([lang], 1080, 'rechts');
  assert.equal(r[0].seite, 'gegenueber');
});

test('lange rechte Nachricht bleibt ich, wird nicht zu Kontext', () => {
  const lang = { text: 'sollen wir uns am wochenende mal in ruhe treffen und reden', x0: 280, x1: 1036 };
  const r = klassifiziereZeilen([lang], 1080, 'rechts');
  assert.equal(r[0].seite, 'ich');
});

test('baueVerlauf fasst aufeinanderfolgende gleiche Seite zusammen und beschriftet', () => {
  const verlauf = baueVerlauf([
    { text: 'Hey', seite: 'ich' },
    { text: 'wie gehts', seite: 'ich' },
    { text: 'Gut danke', seite: 'gegenueber' },
    { text: '12:03', seite: 'kontext' },
    { text: 'Und dir', seite: 'gegenueber' }
  ]);
  assert.equal(
    verlauf,
    'Ich: Hey wie gehts\nGegenüber: Gut danke\n12:03\nGegenüber: Und dir'
  );
});

test('leere Eingaben ergeben leeren Verlauf, kein Absturz', () => {
  assert.equal(baueVerlauf([]), '');
  assert.equal(baueVerlauf(null), '');
  assert.deepEqual(klassifiziereZeilen(null, BREITE, 'rechts'), []);
  assert.deepEqual(sortiereNachHoehe(null), []);
});

test('sortiereNachHoehe bringt spaltenweise gelieferte Zeilen in echte Lesereihenfolge', () => {
  const spaltenweise = [
    { text: 'links-oben', x0: 50, x1: 300, y0: 100, y1: 130 },
    { text: 'links-unten', x0: 50, x1: 300, y0: 300, y1: 330 },
    { text: 'rechts-mitte', x0: 700, x1: 950, y0: 200, y1: 230 }
  ];
  const sortiert = sortiereNachHoehe(spaltenweise);
  assert.deepEqual(sortiert.map((z) => z.text), ['links-oben', 'rechts-mitte', 'links-unten']);
});

test('durchgehende Pipeline mit langer Nachricht: korrekt sortiert und beschriftet', () => {
  // Zwei kurze + eine lange, absichtlich unsortiert geliefert.
  const zeilen = [
    { text: 'Mal schauen', x0: 60, x1: 320, y0: 600, y1: 630 },
    { text: 'Sollen wir uns treffen und in ruhe reden am wochenende', x0: 300, x1: 1036, y0: 100, y1: 130 },
    { text: 'ja gerne', x0: 44, x1: 240, y0: 700, y1: 730 }
  ];
  const verlauf = baueVerlauf(klassifiziereZeilen(sortiereNachHoehe(zeilen), 1080, 'rechts'));
  assert.equal(
    verlauf,
    'Ich: Sollen wir uns treffen und in ruhe reden am wochenende\nGegenüber: Mal schauen ja gerne'
  );
});
