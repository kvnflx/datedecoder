// Tests für den Umgang mit sehr langen Chatverläufen.
//
// Hintergrund: Seit dem Umstieg auf Claude (2026-11-25) ist das Kontextfenster
// mit 1 Mio. Tokens kein Engpass mehr, wohl aber die Kosten: 60 KB Verlauf sind
// rund 30.000 Tokens Eingabe. Gekürzt wird deshalb auf die neuesten
// Nachrichten.
//
// Vorher (NVIDIA): Ein 600-KB-Verlauf kam durchs 1-MB-Upload-Limit, jedes Modell
// antwortete mit HTTP 400 (Kontext überschritten), und der Nutzer sah nach
// 33,8 Sekunden "Server gerade nicht erreichbar" — eine irreführende Meldung
// für ein Problem, das nichts mit der Erreichbarkeit zu tun hat.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { starteMock, sendeStream, sendeFehler, freierPort, TEST_KEY } from './anthropic-mock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server.js');

const upstream = { modus: 'ok', letzterPrompt: null };
let mock;
let app;
let appPort;

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
  // Bytes laufend mitzählen statt Buffer.byteLength(out) pro Zeile: Das wäre
  // quadratisch (2 MB ~ 30 s) und blockierte die Event-Loop des Testprozesses so
  // lange, dass undici eine vom Keep-Alive-Timeout gerade geschlossene Verbindung
  // für den nächsten Request wiederverwendete -> ECONNRESET.
  const zeilen = [];
  let bytes = 0;
  let i = 0;
  while (bytes < zielBytes) {
    const tag = 1 + (i % 28);
    const zeile = `[${String(tag).padStart(2, '0')}.01.2023, 10:${String(i % 60).padStart(2, '0')}] ` +
      `${namen[i % 2]}: ${saetze[i % saetze.length]} #${i}\n`;
    zeilen.push(zeile);
    bytes += Buffer.byteLength(zeile, 'utf8');
    i++;
  }
  return { text: zeilen.join(''), anzahl: i };
}

before(async () => {
  mock = await starteMock((anfrage, res) => {
    const msgs = anfrage.body?.messages;
    upstream.letzterPrompt = Array.isArray(msgs) ? msgs[msgs.length - 1].content : null;

    if (upstream.modus === 'kontext') {
      return sendeFehler(
        res,
        400,
        'invalid_request_error',
        'prompt is too long: 1048577 tokens > 1048576 maximum'
      );
    }
    return sendeStream(res, { model: anfrage.body?.model, texte: ['Analyse'] });
  });

  appPort = await freierPort();
  app = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(appPort),
      ANTHROPIC_API_KEY: TEST_KEY,
      ANTHROPIC_BASE_URL: mock.url,
      CONNECT_TIMEOUT_MS: '3000',
      DAILY_REQUESTS_PER_IP: '1000',
      DAILY_BUDGET_USD: '1000'
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
  if (mock) await mock.schliessen();
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
      gesendet <= 60 * 1024,
      `Es gingen ${Math.round(gesendet / 1024)} KB ans Modell. Ab 60 KB wird gekürzt, ` +
        'sonst sprengt eine einzige Analyse mit Opus 5.5 das Tagesbudget.'
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
