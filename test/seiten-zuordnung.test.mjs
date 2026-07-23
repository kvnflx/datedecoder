import { test } from 'node:test';
import assert from 'node:assert/strict';
import seiten from '../public/seiten.js';

const { klassifiziereZeilen, baueVerlauf } = seiten;

// Bildbreite 1000, Standard-Totzone 0.30 -> Mitte gilt von 350 bis 650.
const BREITE = 1000;
const linksZeile = { text: 'von links', x0: 50, x1: 300 }; // Mitte 175
const rechtsZeile = { text: 'von rechts', x0: 700, x1: 950 }; // Mitte 825
const mitteZeile = { text: '12:03', x0: 420, x1: 580 }; // Mitte 500

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

test('zentrierte Zeile landet als Kontext in der Totzone', () => {
  const r = klassifiziereZeilen([mitteZeile], BREITE, 'rechts');
  assert.equal(r[0].seite, 'kontext');
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
});

test('durchgehende Pipeline: Boxen rein, beschrifteter Verlauf raus', () => {
  const zeilen = [
    { text: 'Sollen wir Freitag?', x0: 680, x1: 940 },
    { text: 'Mal schauen', x0: 60, x1: 320 }
  ];
  const verlauf = baueVerlauf(klassifiziereZeilen(zeilen, BREITE, 'rechts'));
  assert.equal(verlauf, 'Ich: Sollen wir Freitag?\nGegenüber: Mal schauen');
});
