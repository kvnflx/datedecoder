// Tests der Fehlerbehandlung gegen einen Mock-Upstream — kein API-Key nötig.
//
// Hintergrund zum 503: Cloudflare ersetzt Origin-Antworten mit Status 502 und 504
// durch eine eigene text/plain-Seite und verwirft den Body. Kontrolliert gemessen:
// 400/429/500/503 werden unverändert durchgereicht, 502 und 504 nicht. Ein
// res.status(502).json({error:...}) erreicht den Browser deshalb strukturell nie —
// das Frontend sah nur "Unbekannter Fehler". Der Server muss darum 503 senden.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server.js');

/** Steuert, wie der Mock-Upstream auf den nächsten Request antwortet. */
const upstream = { modus: 'tot' };

let mock;
let mockPort;
let app;
let appPort;

async function freierPort() {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

/** Startet server.js als Subprozess und wartet auf die Startmeldung. */
async function starteApp(env = {}, warten = true) {
  const port = await freierPort();
  const proc = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(port),
      NVIDIA_API_KEY: 'nvapi-testschluessel-nur-fuer-den-mock-0123456789',
      NVIDIA_URL: `http://127.0.0.1:${mockPort}/v1/chat/completions`,
      CONNECT_TIMEOUT_MS: '1500',
      IDLE_TIMEOUT_MS: '1500',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.logs = '';
  proc.stdout.on('data', (d) => { proc.logs += d.toString(); });
  proc.stderr.on('data', (d) => { proc.logs += d.toString(); });

  if (warten) {
    const bis = Date.now() + 15000;
    while (Date.now() < bis && !/running on port/i.test(proc.logs)) {
      if (proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { proc, port };
}

function stoppe(proc) {
  if (proc && proc.exitCode === null) proc.kill();
}

before(async () => {
  mock = createServer((req, res) => {
    if (upstream.modus === 'tot') {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 410, detail: 'Modell abgeschaltet (Mock)' }));
      return;
    }
    if (upstream.modus === 'limit') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 429, detail: 'Rate limit (Mock)' }));
      return;
    }
    if (upstream.modus === 'haengt') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // absichtlich nichts senden und offen lassen
      return;
    }
    // 'ok' — ein vollständiger SSE-Stream
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hallo"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":" Welt"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  mockPort = mock.address().port;

  const gestartet = await starteApp();
  app = gestartet.proc;
  appPort = gestartet.port;
});

after(async () => {
  stoppe(app);
  if (mock) await new Promise((r) => mock.close(r));
});

const url = () => `http://127.0.0.1:${appPort}/api/chat`;
const body = (text = 'Testverlauf') =>
  JSON.stringify({ messages: [{ role: 'user', content: text }] });

describe('Fehlerpfade', () => {
  test('leitet den Upstream über NVIDIA_URL um', () => {
    // Ohne diese Umleitbarkeit lässt sich der Fehlerpfad überhaupt nicht testen,
    // ohne die echte API zu belasten.
    assert.match(
      app.logs,
      /running on port/i,
      `Server nicht gestartet. Logs:\n${app.logs}`
    );
  });

  test('alle Modelle tot -> HTTP 503 mit JSON-Fehlermeldung', async () => {
    upstream.modus = 'tot';
    const r = await fetch(url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body()
    });

    assert.equal(
      r.status,
      503,
      `Erwartet 503, bekam ${r.status}. Ein 502 wird von Cloudflare ersetzt und ` +
        'die Fehlermeldung erreicht den Browser nie.'
    );
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    const j = await r.json();
    assert.equal(typeof j.error, 'string');
    assert.ok(j.error.length > 10, 'Die Fehlermeldung muss für Nutzer verständlich sein');
  });

  test('protokolliert den Fehler-Body des Upstreams', async () => {
    upstream.modus = 'tot';
    await fetch(url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body() });
    await new Promise((r) => setTimeout(r, 300));

    assert.match(
      app.logs,
      /Modell abgeschaltet \(Mock\)/,
      'Der Fehler-Body des Upstreams muss im Log stehen — genau dort nennt NVIDIA ' +
        'Modellname und Abschaltdatum. Ohne ihn ist der nächste Ausfall wieder ein Blindflug.'
    );
  });

  test('durchgehendes Rate-Limit -> HTTP 429', async () => {
    upstream.modus = 'limit';
    const r = await fetch(url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body()
    });
    assert.equal(r.status, 429);
  });

  test('hängender Upstream wird abgebrochen statt endlos zu warten', async () => {
    upstream.modus = 'haengt';
    const t0 = Date.now();
    const r = await fetch(url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body()
    });
    await r.text().catch(() => '');
    const dauer = Date.now() - t0;

    assert.ok(
      dauer < 30000,
      `Antwort erst nach ${dauer} ms. Ohne fetch-Timeout hängt der Server, bis ` +
        'Cloudflare nach 120 s mit einem 524 abbricht.'
    );
  });

  test('erfolgreicher Stream wird durchgereicht', async () => {
    upstream.modus = 'ok';
    const r = await fetch(url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body()
    });
    assert.equal(r.status, 200);
    const txt = await r.text();
    assert.match(txt, /Hallo/);
    assert.match(txt, /\[DONE\]/);
  });

  test('zu großer Body -> 413 als JSON, nicht als HTML-Stacktrace', async () => {
    const r = await fetch(url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body('x'.repeat(1_200_000))
    });

    assert.equal(r.status, 413);
    const ct = r.headers.get('content-type') || '';
    assert.match(ct, /application\/json/, `Content-Type war "${ct}" — ein HTML-Stacktrace ` +
      'verrät Container-Pfade und ist für das Frontend nicht parsebar.');
    const j = await r.json();
    assert.equal(typeof j.error, 'string');
  });

  test('ungültiges JSON -> 400 als JSON', async () => {
    const r = await fetch(url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{kaputt'
    });
    assert.equal(r.status, 400);
    assert.match(r.headers.get('content-type') || '', /application\/json/);
  });

  test('/healthz meldet die aktive Modell-Kette', async () => {
    const r = await fetch(`http://127.0.0.1:${appPort}/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.models) && j.models.length >= 3);
  });
});

describe('Startup-Validierung', () => {
  test('ohne API-Key startet der Server gar nicht erst', async () => {
    const { proc } = await starteApp({ NVIDIA_API_KEY: '' }, false);
    const bis = Date.now() + 10000;
    while (Date.now() < bis && proc.exitCode === null) {
      await new Promise((r) => setTimeout(r, 100));
    }
    stoppe(proc);

    assert.notEqual(
      proc.exitCode,
      null,
      'Der Prozess läuft ohne API-Key weiter. Dann baut jeder Request den Header ' +
        '"Bearer undefined" und der Fehler endet als nichtssagender 503.'
    );
    assert.notEqual(proc.exitCode, 0, 'Fehlender API-Key muss zu einem Fehler-Exitcode führen');
    assert.match(proc.logs, /NVIDIA_API_KEY/i, 'Das Log muss die Ursache benennen');
  });
});
