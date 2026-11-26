// Integrationstests der Schutzschichten gegen den echten Server mit Mock-Upstream.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { starteMock, sendeStream, freierPort, TEST_KEY } from './anthropic-mock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server.js');
const CF_PEER = '173.245.48.1';

const zustand = { turnstileOk: true, haengt: false };
let mock;

async function starteApp(env = {}, warten = true) {
  const port = await freierPort();
  const proc = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(port),
      ANTHROPIC_API_KEY: TEST_KEY,
      ANTHROPIC_BASE_URL: mock.url,
      CONNECT_TIMEOUT_MS: '1500',
      IDLE_TIMEOUT_MS: '3000',
      DAILY_REQUESTS_PER_IP: '1000',
      DAILY_BUDGET_USD: '1000',
      CLOUDFLARE_PFLICHT: 'aus',
      TURNSTILE_VERIFY_URL: `${mock.url}/siteverify`,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.logs = '';
  proc.stdout.on('data', (d) => { proc.logs += d.toString(); });
  proc.stderr.on('data', (d) => { proc.logs += d.toString(); });
  if (warten) {
    const bis = Date.now() + 15000;
    while (Date.now() < bis && !/running on port/i.test(proc.logs) && proc.exitCode === null) {
      await new Promise((r) => setTimeout(r, 100));
    }
  } else {
    const bis = Date.now() + 10000;
    while (Date.now() < bis && proc.exitCode === null) await new Promise((r) => setTimeout(r, 100));
  }
  proc.port = port;
  return proc;
}
const stoppe = (p) => p && p.exitCode === null && p.kill();

before(async () => {
  mock = await starteMock((anfrage, res) => {
    if (anfrage.pfad === '/siteverify') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(zustand.turnstileOk ? { success: true, action: 'analyse' } : { success: false }));
    }
    if (zustand.haengt) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.flushHeaders();
    }
    sendeStream(res, { model: anfrage.body?.model, texte: ['ok'] });
  });
});
after(async () => {
  if (mock) await mock.schliessen();
});

const gueltig = JSON.stringify({ messages: [{ role: 'user', content: 'Hallo' }] });

async function post(port, { headers = {}, body = gueltig } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body
  });
  const text = await r.text();
  return { status: r.status, text, headers: r.headers };
}

describe('Security-Header', () => {
  let app;
  before(async () => { app = await starteApp(); });
  after(() => stoppe(app));

  test('Startseite liefert CSP mit Nonce und alle Schutz-Header, kein x-powered-by', async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/`);
    await r.text();
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.headers.get('permissions-policy') || '', /camera=\(\)/);
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(r.headers.get('x-powered-by'), null, 'Express darf sich nicht verraten');
  });

  test('Nonce ist pro Antwort neu', async () => {
    const a = (await fetch(`http://127.0.0.1:${app.port}/`)).headers.get('content-security-policy');
    const b = (await fetch(`http://127.0.0.1:${app.port}/`)).headers.get('content-security-policy');
    assert.notEqual(a, b);
  });

  test('versteckte Dateien werden nicht ausgeliefert', async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/.env`);
    assert.ok([403, 404].includes(r.status), `Status ${r.status}`);
    assert.doesNotMatch(await r.text(), /API_KEY/);
  });

  test('API-Antworten werden nie gecacht', async () => {
    const r = await post(app.port);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});

describe('Anfrage-Prüfungen', () => {
  let app;
  before(async () => { app = await starteApp(); });
  after(() => stoppe(app));

  test('Browser-Anfrage von fremder Seite -> 403', async () => {
    assert.equal((await post(app.port, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await post(app.port, { headers: { origin: 'https://boese.example' } })).status, 403);
  });

  test('eigene Seite geht durch', async () => {
    const r = await post(app.port, {
      headers: { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${app.port}` }
    });
    assert.equal(r.status, 200);
  });

  test('kein JSON -> 415', async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: gueltig
    });
    assert.equal(r.status, 415);
  });

  test('über 100 Nachrichten -> 400', async () => {
    const viele = Array.from({ length: 101 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }));
    viele.push({ role: 'user', content: 'x' });
    assert.equal((await post(app.port, { body: JSON.stringify({ messages: viele }) })).status, 400);
  });

  test('Body über 3 MB -> 413', async () => {
    const r = await post(app.port, { body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(3_200_000) }] }) });
    assert.equal(r.status, 413);
  });
});

describe('Nur über Cloudflare', () => {
  let app;
  before(async () => { app = await starteApp({ CLOUDFLARE_PFLICHT: 'erzwingen', ORIGIN_SECRET: 'geheim-test-123' }); });
  after(() => stoppe(app));

  test('direkt an Cloudflare vorbei -> 403, auch mit gefälschtem cf-connecting-ip', async () => {
    const r = await post(app.port, { headers: { 'cf-connecting-ip': '9.9.9.9', 'x-dd-origin': 'geheim-test-123' } });
    assert.equal(r.status, 403);
  });

  test('Cloudflare-IP ohne Origin-Geheimnis -> 403', async () => {
    const r = await post(app.port, { headers: { 'x-forwarded-for': CF_PEER } });
    assert.equal(r.status, 403, 'Andere Cloudflare-Kunden dürfen nicht durchkommen');
  });

  test('Cloudflare-IP mit Origin-Geheimnis -> 200', async () => {
    const r = await post(app.port, { headers: { 'x-forwarded-for': CF_PEER, 'x-dd-origin': 'geheim-test-123' } });
    assert.equal(r.status, 200);
  });

  test('Abgewiesenes taucht im Log auf', () => {
    assert.match(app.logs, /ist NICHT Cloudflare.*abgelehnt/);
  });
});

describe('Melde-Modus', () => {
  let app;
  before(async () => { app = await starteApp({ CLOUDFLARE_PFLICHT: 'melden' }); });
  after(() => stoppe(app));

  test('protokolliert, lässt aber durch', async () => {
    const r = await post(app.port);
    assert.equal(r.status, 200);
    assert.match(app.logs, /würde abgelehnt/);
  });
});

describe('Turnstile', () => {
  let app;
  before(async () => {
    app = await starteApp({
      TURNSTILE_SITEKEY: '1x00000000000000000000BB',
      TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
      DAILY_REQUESTS_PER_IP: '1'
    });
  });
  after(() => stoppe(app));

  test('/api/config liefert den öffentlichen Site-Key, nie das Secret', async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/api/config`);
    const txt = await r.text();
    assert.equal(JSON.parse(txt).turnstileSiteKey, '1x00000000000000000000BB');
    assert.doesNotMatch(txt, /0000000000000000000000000000000AA/);
  });

  test('ohne Token -> 403, und es wird weder Modell noch Kontingent angefasst', async () => {
    const vorher = mock.anfragen.filter((a) => a.pfad === '/v1/messages').length;
    zustand.turnstileOk = true;
    assert.equal((await post(app.port)).status, 403);
    zustand.turnstileOk = false;
    assert.equal((await post(app.port, { headers: { 'x-turnstile-token': 'falsch' } })).status, 403);
    zustand.turnstileOk = true;
    assert.equal(mock.anfragen.filter((a) => a.pfad === '/v1/messages').length, vorher);
    // Kontingent ist 1: Die gültige Anfrage muss noch durchgehen.
    assert.equal((await post(app.port, { headers: { 'x-turnstile-token': 'gut' } })).status, 200);
  });
});

describe('Parallelität', () => {
  let app;
  before(async () => { app = await starteApp(); });
  after(() => stoppe(app));

  test('zweite gleichzeitige Analyse derselben IP -> 429', async () => {
    zustand.haengt = true;
    const erste = post(app.port);
    await new Promise((r) => setTimeout(r, 300));
    const zweite = await post(app.port);
    zustand.haengt = false;
    assert.equal(zweite.status, 429);
    await erste; // endet per Idle-Timeout
    assert.equal((await post(app.port)).status, 200, 'Nach dem Ende ist der Platz wieder frei');
  });
});

describe('Startprüfung der Konfiguration', () => {
  test('Turnstile nur halb konfiguriert -> Server startet nicht', async () => {
    const p = await starteApp({ TURNSTILE_SITEKEY: 'x', TURNSTILE_SECRET: '' }, false);
    stoppe(p);
    assert.notEqual(p.exitCode, 0);
    assert.match(p.logs, /TURNSTILE/);
  });

  test('ungültiger Cloudflare-Modus -> Server startet nicht', async () => {
    const p = await starteApp({ CLOUDFLARE_PFLICHT: 'vielleicht' }, false);
    stoppe(p);
    assert.notEqual(p.exitCode, 0);
  });

  test('in Produktion ist die Cloudflare-Pflicht ohne Angabe an', async () => {
    const p = await starteApp({ NODE_ENV: 'production', CLOUDFLARE_PFLICHT: '' });
    stoppe(p);
    assert.match(p.logs, /Cloudflare-Pflicht erzwingen/);
  });
});
