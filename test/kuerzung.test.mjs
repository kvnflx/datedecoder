// Tests für den Umgang mit sehr langen Chatverläufen.
//
// Hintergrund: Das Kontextfenster ist pro Modell unterschiedlich — gemessen
// 262.144 Tokens bei mistral-small-4, aber nur 131.072 bei llama-3.3-70b. Das
// schwächste Glied bestimmt die Grenze, sonst scheitert der Fallback genau dann,
// wenn er gebraucht wird.
//
// Vorher: Ein 600-KB-Verlauf kam durchs 1-MB-Upload-Limit, jedes Modell
// antwortete mit HTTP 400 (Kontext überschritten), und der Nutzer sah nach
// 33,8 Sekunden "Server gerade nicht erreichbar" — eine irreführende Meldung
// für ein Problem, das nichts mit der Erreichbarkeit zu tun hat.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server.js');

const upstream = { modus: 'ok', letzterPrompt: null };
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

/** Baut einen WhatsApp-artigen Verlauf der gewünschten Größe. */
function chatverlauf(zielBytes) {
  const saetze = [
    'Hey wie gehts dir heute?',
    'Alles gut bei dir?',
    'Ja klar, machen wir',
    'Bin gerade unterwegs, melde mich spaeter',
    'Was machst du am Wochenende?'
  ];
  const namen = ['Lisa', 'Ich'];
  let out = '';
  let i = 0;
  while (Buffer.byteLength(out, 'utf8') < zielBytes) {
    const tag = 1 + (i % 28);
    out += `[${String(tag).padStart(2, '0')}.01.2023, 10:${String(i % 60).padStart(2, '0')}] ` +
      `${namen[i % 2]}: ${saetze[i % saetze.length]} #${i}\n`;
    i++;
  }
  return { text: out, anzahl: i };
}

before(async () => {
  mock = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        upstream.letzterPrompt = j.messages[j.messages.length - 1].content;
      } catch (e) {
        upstream.letzterPrompt = null;
      }

      if (upstream.modus === 'kontext') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message:
                'You passed 340691 input tokens and requested 512 output tokens. ' +
                "However, the model's context length is only 262144 tokens."
            }
          })
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Analyse"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  mockPort = mock.address().port;

  appPort = await freierPort();
  app = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(appPort),
      NVIDIA_API_KEY: 'nvapi-testschluessel-nur-fuer-den-mock-0123456789',
      NVIDIA_URL: `http://127.0.0.1:${mockPort}/v1/chat/completions`,
      CONNECT_TIMEOUT_MS: '3000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.logs = '';
  app.stdout.on('data', (d) => { app.logs += d.toString(); });
  app.stderr.on('data', (d) => { app.logs += d.toString(); });

  const bis = Date.now() + 15000;
  while (Date.now() < bis && !/running on port/i.test(app.logs)) {
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (app && app.exitCode === null) app.kill();
  if (mock) await new Promise((r) => mock.close(r));
});

async function analysiere(text) {
  const r = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: text }] })
  });
  const roh = await r.text();
  const hinweise = [];
  for (const zeile of roh.split('\n')) {
    const s = zeile.trim();
    if (!s.startsWith('data: ')) continue;
    const d = s.slice(6);
    if (d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      if (j.hinweis) hinweise.push(j.hinweis);
    } catch (e) {
      /* ignorieren */
    }
  }
  return { status: r.status, roh, hinweise };
}

describe('Lange Chatverläufe', () => {
  test('kurzer Verlauf wird unverändert durchgereicht, ohne Hinweis', async () => {
    const { text } = chatverlauf(5 * 1024);
    const { status, hinweise } = await analysiere(text);

    assert.equal(status, 200);
    assert.deepEqual(hinweise, [], 'Bei kurzen Verläufen darf kein Hinweis erscheinen');
    assert.equal(
      upstream.letzterPrompt,
      text,
      'Ein kurzer Verlauf muss vollständig beim Modell ankommen'
    );
  });

  test('überlanger Verlauf wird gekürzt statt abgelehnt', async () => {
    const { text } = chatverlauf(600 * 1024);
    const { status } = await analysiere(text);

    assert.equal(status, 200, 'Ein langer Verlauf darf nicht mehr in einem Fehler enden');
    const gesendet = Buffer.byteLength(upstream.letzterPrompt || '', 'utf8');
    assert.ok(
      gesendet < 260 * 1024,
      `Es gingen ${Math.round(gesendet / 1024)} KB ans Modell. Das schwächste Modell der ` +
        'Kette (llama-3.3-70b) kann nur 131.072 Tokens — bei ~570 Tokens/KB sind das gut 220 KB.'
    );
  });

  test('behält die NEUESTEN Nachrichten, nicht die ältesten', async () => {
    const { text, anzahl } = chatverlauf(600 * 1024);
    await analysiere(text);
    const gesendet = upstream.letzterPrompt || '';

    assert.ok(
      gesendet.includes(`#${anzahl - 1}`),
      'Die letzte Nachricht des Verlaufs muss enthalten sein — für eine Dating-Analyse ' +
        'zählt die aktuelle Dynamik, nicht die von vor drei Jahren.'
    );
    assert.ok(!gesendet.includes('#0\n'), 'Die allererste Nachricht darf weggefallen sein');
  });

  test('schneidet an Nachrichtengrenzen, nicht mitten im Satz', async () => {
    const { text } = chatverlauf(600 * 1024);
    await analysiere(text);
    const gesendet = upstream.letzterPrompt || '';

    // Der gekürzte Teil (ohne evtl. vorangestellten Hinweis) muss mit einer
    // vollständigen Zeile beginnen.
    const ersteZeile = gesendet.split('\n').find((z) => z.includes('#'));
    assert.match(
      ersteZeile || '',
      /^\[\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}\]/,
      `Erste übertragene Zeile ist angeschnitten: "${(ersteZeile || '').slice(0, 60)}"`
    );
  });

  test('meldet die Kürzung transparent als Hinweis-Event', async () => {
    const { text, anzahl } = chatverlauf(600 * 1024);
    const { hinweise } = await analysiere(text);

    assert.equal(hinweise.length, 1, 'Genau ein Hinweis-Event erwartet');
    const h = hinweise[0];
    assert.match(h, /\d/, 'Der Hinweis muss konkrete Zahlen nennen');
    assert.ok(
      h.includes(String(anzahl)) || h.includes(anzahl.toLocaleString('de')),
      `Der Hinweis muss die Gesamtzahl (${anzahl}) nennen, damit klar ist was fehlt. Hinweis: "${h}"`
    );
  });

  test('nimmt Uploads deutlich über 1 MB an', async () => {
    const { text } = chatverlauf(2 * 1024 * 1024);
    const { status } = await analysiere(text);

    assert.equal(
      status,
      200,
      'Ein 3-Jahres-Export liegt bei ~1,6 MB. Der muss angenommen und gekürzt ' +
        'werden, statt am Upload-Limit zu scheitern.'
    );
  });

  test('Kontext-Fehler des Modells wird als solcher gemeldet, nicht als 503', async () => {
    upstream.modus = 'kontext';
    const { text } = chatverlauf(5 * 1024);
    const r = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] })
    });
    const j = await r.json().catch(() => ({}));
    upstream.modus = 'ok';

    assert.equal(r.status, 413, `Erwartet 413 (zu groß), bekam ${r.status}`);
    assert.match(
      j.error || '',
      /lang|groß|kürz/i,
      `Die Meldung muss auf die Länge hinweisen, nicht auf Erreichbarkeit. War: "${j.error}"`
    );
  });
});
