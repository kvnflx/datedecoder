// Unit-Tests der Kostenbremse (limits.js) mit gesteuerter Uhr.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { kostenUsd, sekundenBisMorgen, TagesLimit, TagesBudget } = require('../limits.js');

const MITTAG = Date.UTC(2026, 10, 25, 12, 0, 0);
const NAECHSTER_TAG = Date.UTC(2026, 10, 26, 0, 0, 1);

describe('kostenUsd', () => {
  test('rechnet Opus 5.5 mit 4 / 20 USD pro Mio. Tokens', () => {
    // Gemessen am 2026-11-25: 3.485 Eingabe-, 3.560 Ausgabe-Tokens = 0,0851 USD
    const k = kostenUsd('claude-opus-5-5', { input_tokens: 3485, output_tokens: 3560 });
    assert.ok(Math.abs(k - 0.08514) < 1e-6, `war ${k}`);
  });

  test('unbekanntes Modell wird teuer gerechnet, nie zu billig', () => {
    const u = { input_tokens: 1000, output_tokens: 1000 };
    assert.ok(kostenUsd('claude-irgendwas-9', u) >= kostenUsd('claude-opus-5-5', u));
  });

  test('Haiku 5.5 über 100K Prompt-Tokens kostet den höheren Satz', () => {
    const kurz = kostenUsd('claude-haiku-5-5', { input_tokens: 100000, output_tokens: 0 });
    const lang = kostenUsd('claude-haiku-5-5', { input_tokens: 100001, output_tokens: 0 });
    assert.ok(lang > kurz * 4, 'Ab 100K gilt 0,50 statt 0,10 USD pro Mio. Eingabe-Tokens');
  });

  test('Cache-Tokens werden mitgerechnet', () => {
    const ohne = kostenUsd('claude-opus-5-5', { input_tokens: 0, output_tokens: 0 });
    const mit = kostenUsd('claude-opus-5-5', { cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000 });
    assert.equal(ohne, 0);
    assert.ok(mit > 0);
  });
});

describe('TagesLimit', () => {
  test('lässt genau max Anfragen pro Schlüssel und Tag zu', () => {
    const l = new TagesLimit({ max: 2, jetzt: () => MITTAG });
    assert.equal(l.nehmen('a'), true);
    assert.equal(l.nehmen('a'), true);
    assert.equal(l.nehmen('a'), false);
    assert.equal(l.nehmen('b'), true, 'Andere IPs sind unabhängig');
  });

  test('zurückgegebene Anfragen sind wieder frei', () => {
    const l = new TagesLimit({ max: 1, jetzt: () => MITTAG });
    assert.equal(l.nehmen('a'), true);
    l.zurueckgeben('a');
    assert.equal(l.nehmen('a'), true);
  });

  test('setzt um Mitternacht UTC zurück', () => {
    let jetzt = MITTAG;
    const l = new TagesLimit({ max: 1, jetzt: () => jetzt });
    assert.equal(l.nehmen('a'), true);
    assert.equal(l.nehmen('a'), false);
    jetzt = NAECHSTER_TAG;
    assert.equal(l.nehmen('a'), true);
  });
});

describe('TagesBudget', () => {
  test('lehnt Reservierungen über dem Limit ab', () => {
    const b = new TagesBudget({ limitUsd: 1, jetzt: () => MITTAG });
    assert.ok(b.reservieren(0.6));
    assert.equal(b.reservieren(0.6), null, 'Offene Reservierungen zählen mit');
  });

  test('rechnet die echten Kosten statt der Reservierung ab', () => {
    const b = new TagesBudget({ limitUsd: 1, jetzt: () => MITTAG });
    const r = b.reservieren(0.6);
    b.abrechnen(r, 0.1);
    assert.deepEqual(
      { ausgegeben: b.stand().ausgegeben, reserviert: b.stand().reserviert },
      { ausgegeben: 0.1, reserviert: 0 }
    );
    assert.ok(b.reservieren(0.8), '0,1 ausgegeben + 0,8 passt in 1,0');
  });

  test('doppeltes Abrechnen bucht nicht doppelt', () => {
    const b = new TagesBudget({ limitUsd: 1, jetzt: () => MITTAG });
    const r = b.reservieren(0.5);
    b.abrechnen(r, 0.3);
    b.abrechnen(r, 0.3);
    assert.equal(b.stand().ausgegeben, 0.3);
  });

  test('beginnt am nächsten Tag von vorn', () => {
    let jetzt = MITTAG;
    const b = new TagesBudget({ limitUsd: 1, jetzt: () => jetzt });
    b.abrechnen(b.reservieren(0.9), 0.9);
    assert.equal(b.reservieren(0.5), null);
    jetzt = NAECHSTER_TAG;
    assert.ok(b.reservieren(0.5));
  });
});

test('sekundenBisMorgen zählt bis Mitternacht UTC', () => {
  assert.equal(sekundenBisMorgen(MITTAG), 12 * 3600);
});
