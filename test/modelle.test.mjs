// Smoke-Test der Modell-Kette gegen die echte NVIDIA-NIM-API.
//
// Dieser Test existiert wegen des Ausfalls vom 2026-07-20: NVIDIA hat
// 'qwen/qwen3.5-122b-a10b' abgeschaltet (410 Gone) und 'mistralai/mistral-large'
// war für den Account nicht mehr auflösbar (404). Beide Glieder der Kette fielen
// gleichzeitig aus, gemerkt hat es niemand — bis Nutzer "Unbekannter Fehler" sahen.
//
// Läuft nur mit gesetztem NVIDIA_API_KEY, sonst wird der Live-Teil übersprungen:
//   NVIDIA_API_KEY=nvapi-... npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server.js');
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Die Modell-IDs werden aus dem Quelltext gelesen statt importiert, damit der
// Test keine Seiteneffekte auslöst (ein require würde den Server starten).
function leseModelle() {
  const src = readFileSync(SERVER_JS, 'utf8');
  const block = src.match(/const MODELS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'MODELS-Array in server.js nicht gefunden');
  return [...block[1].matchAll(/['"]([^'"]+\/[^'"]+)['"]/g)].map((m) => m[1]);
}

const KEY = (process.env.NVIDIA_API_KEY || '').trim();

describe('Modell-Kette', () => {
  test('enthält mindestens drei Modelle', () => {
    assert.ok(
      leseModelle().length >= 3,
      'Die Kette braucht mindestens drei Glieder — bei zweien reicht ein einzelnes ' +
        'Modell-Ende, um die App komplett lahmzulegen (siehe 2026-07-20).'
    );
  });

  test('verteilt sich über mindestens zwei Anbieter', () => {
    const anbieter = new Set(leseModelle().map((m) => m.split('/')[0]));
    assert.ok(
      anbieter.size >= 2,
      `Alle Modelle stammen von "${[...anbieter].join(', ')}". Ein einzelner ` +
        'Anbieter-Rollout kann damit die gesamte Kette killen.'
    );
  });

  test('enthält kein bekannt totes Modell', () => {
    const tot = ['qwen/qwen3.5-122b-a10b', 'mistralai/mistral-large'];
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
});

describe('Live-Verfügbarkeit', { skip: KEY.length < 20 ? 'NVIDIA_API_KEY nicht gesetzt' : false }, () => {
  test('jedes Modell der Kette antwortet mit HTTP 200', async (t) => {
    const fehler = [];

    for (const model of leseModelle()) {
      let status = 0;
      let detail = '';
      try {
        const r = await fetch(NVIDIA_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Antworte mit genau einem Wort: OK' }],
            max_tokens: 16,
            stream: false
          }),
          signal: AbortSignal.timeout(60000)
        });
        status = r.status;
        if (!r.ok) detail = (await r.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
      } catch (err) {
        detail = err.message;
      }

      t.diagnostic(`${model} -> ${status || 'Fehler'} ${detail}`);
      if (status !== 200) fehler.push(`${model} -> ${status || 'Fehler'}: ${detail}`);
    }

    assert.deepEqual(fehler, [], `Nicht erreichbare Modelle:\n  ${fehler.join('\n  ')}`);
  });
});
