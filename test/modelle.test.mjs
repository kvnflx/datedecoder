// Prüft die Modell-Kette: statisch immer, gegen die echte Anthropic-API nur mit Key.
//
// Dieser Test existiert wegen zweier Totalausfälle auf NVIDIA NIM: Am 2026-07-20
// fielen 'qwen/qwen3.5-122b-a10b' (410) und 'mistralai/mistral-large' (404)
// gleichzeitig aus, am 2026-11-24 mit 'google/gemma-4-31b-it' das letzte Glied der
// Ersatzkette. Gemerkt hat es beide Male niemand, bis Nutzer Fehler sahen.
//
// Der Live-Teil fragt die Models-API ab. Das kostet nichts und schlägt an, sobald
// ein Modell der Kette für den Account nicht mehr existiert:
//   ANTHROPIC_API_KEY=sk-ant-... npm run test:live
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server.js');

// Die Modell-IDs werden aus dem Quelltext gelesen statt importiert, damit der
// Test keine Seiteneffekte auslöst (ein require würde den Server starten).
function leseModelle() {
  const src = readFileSync(SERVER_JS, 'utf8');
  const block = src.match(/const MODELS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'MODELS-Array in server.js nicht gefunden');
  return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

const KEY = (process.env.ANTHROPIC_API_KEY || '').trim();

describe('Modell-Kette', () => {
  test('enthält mindestens drei Modelle', () => {
    assert.ok(
      leseModelle().length >= 3,
      'Die Kette braucht mindestens drei Glieder. Jedes Modell hat ein eigenes ' +
        'Rate-Limit, Überlast beim einen fängt das nächste auf.'
    );
  });

  test('enthält nur Claude-Modelle ohne Datums- oder Alias-Anhängsel', () => {
    for (const m of leseModelle()) {
      assert.match(
        m,
        /^claude-[a-z]+-\d+(-\d+)?$/,
        `"${m}" ist keine gültige Claude-Modell-ID. NVIDIA-IDs (anbieter/modell) ` +
          'funktionieren mit der Anthropic-API nicht.'
      );
    }
  });

  test('enthält kein bekannt totes Modell', () => {
    const tot = [
      'qwen/qwen3.5-122b-a10b',
      'mistralai/mistral-large',
      'mistralai/mistral-small-4-119b-2603',
      'google/gemma-4-31b-it',
      'meta/llama-3.3-70b-instruct'
    ];
    const treffer = leseModelle().filter((m) => tot.includes(m));
    assert.deepEqual(treffer, [], `Abgeschaltete Modelle in der Kette: ${treffer.join(', ')}`);
  });

  test('Gesamtbudget der Kette bleibt unter Cloudflares 100-Sekunden-Grenze', () => {
    const src = readFileSync(SERVER_JS, 'utf8');
    const m = src.match(/CONNECT_TIMEOUT_MS\s*=\s*Number\([^)]*\)\s*\|\|\s*(\d+)/);
    assert.ok(m, 'CONNECT_TIMEOUT_MS in server.js nicht gefunden');

    const timeout = Number(m[1]);
    const budget = leseModelle().length * timeout;

    assert.ok(
      budget <= 100000,
      `Fallen alle ${leseModelle().length} Modelle in den Timeout, wartet der Server ` +
        `${budget / 1000} s. Cloudflare bricht die Verbindung aber schon vorher ab und ` +
        'ersetzt sie durch einen 524 — die saubere Fehlermeldung erreicht den Browser dann nie. ' +
        `Entweder CONNECT_TIMEOUT_MS senken (aktuell ${timeout / 1000} s) oder die Kette kürzen.`
    );
  });

  test('SDK-Retries sind aus, sonst sprengen sie das Timeout-Budget', () => {
    const src = readFileSync(SERVER_JS, 'utf8');
    assert.match(src, /maxRetries:\s*0/, 'Die Modell-Kette ist das Retry, das SDK darf nicht zusätzlich wiederholen');
  });
});

describe('Live-Verfügbarkeit', { skip: KEY.length < 20 ? 'ANTHROPIC_API_KEY nicht gesetzt' : false }, () => {
  test('jedes Modell der Kette existiert für den Account', async (t) => {
    const client = new Anthropic({ apiKey: KEY });
    const fehler = [];

    for (const model of leseModelle()) {
      try {
        const info = await client.models.retrieve(model);
        t.diagnostic(`${model} -> ok (${info.display_name})`);
      } catch (err) {
        const status = err instanceof Anthropic.APIError ? err.status : 'Fehler';
        t.diagnostic(`${model} -> ${status} ${err.message}`);
        fehler.push(`${model} -> ${status}: ${String(err.message).slice(0, 200)}`);
      }
    }

    assert.deepEqual(fehler, [], `Nicht verfügbare Modelle:\n  ${fehler.join('\n  ')}`);
  });
});
