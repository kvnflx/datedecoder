// Unit-Tests der Schutzschichten in haertung.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const h = require('../haertung.js');

const req = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });

describe('Cloudflare-Netze', () => {
  test('erkennt Cloudflare-IPs in v4, v6 und IPv4-in-IPv6-Schreibweise', () => {
    assert.equal(h.istCloudflareIp('173.245.48.1'), true);
    assert.equal(h.istCloudflareIp('104.16.0.5'), true);
    assert.equal(h.istCloudflareIp('2606:4700::1'), true);
    assert.equal(h.istCloudflareIp('::ffff:162.158.1.1'), true);
  });

  test('lehnt fremde und kaputte Adressen ab', () => {
    for (const ip of ['159.195.247.83', '1.2.3.4', '127.0.0.1', '2001:db8::1', '', 'kaputt', undefined]) {
      assert.equal(h.istCloudflareIp(ip), false, String(ip));
    }
  });
});

describe('Herkunft', () => {
  test('Peer ist der LETZTE X-Forwarded-For-Eintrag (den setzt Traefik)', () => {
    assert.equal(h.peerIp(req({ 'x-forwarded-for': '1.2.3.4, 173.245.48.1' })), '173.245.48.1');
    assert.equal(h.peerIp(req({}, '10.0.0.7')), '10.0.0.7');
  });

  test('gefälschter erster XFF-Eintrag macht keine Cloudflare-Anfrage', () => {
    const r = h.herkunft(req({ 'x-forwarded-for': '173.245.48.1, 6.6.6.6' }), '');
    assert.equal(r.ok, false);
  });

  test('mit Origin-Geheimnis reicht die Cloudflare-IP allein nicht', () => {
    const ohne = h.herkunft(req({ 'x-forwarded-for': '173.245.48.1' }), 'geheim-123');
    const falsch = h.herkunft(req({ 'x-forwarded-for': '173.245.48.1', 'x-dd-origin': 'geheim-124' }), 'geheim-123');
    const richtig = h.herkunft(req({ 'x-forwarded-for': '173.245.48.1', 'x-dd-origin': 'geheim-123' }), 'geheim-123');
    assert.equal(ohne.ok, false);
    assert.equal(falsch.ok, false);
    assert.equal(richtig.ok, true);
  });

  test('cf-connecting-ip zählt nur bei nachgewiesener Cloudflare-Herkunft', () => {
    const direkt = req({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '6.6.6.6' });
    assert.equal(h.clientIp(direkt, h.herkunft(direkt, '')), '6.6.6.6', 'Direkter Zugriff darf seine IP nicht fälschen');
    const cf = req({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '173.245.48.1' });
    assert.equal(h.clientIp(cf, h.herkunft(cf, '')), '9.9.9.9');
  });
});

describe('Fremde Seiten', () => {
  test('Browser-Anfrage von fremder Seite wird erkannt', () => {
    assert.equal(h.istFremdeSeite(req({ 'sec-fetch-site': 'cross-site', host: 'a.de' })), true);
    assert.equal(h.istFremdeSeite(req({ 'sec-fetch-site': 'same-site', host: 'a.de' })), true);
    assert.equal(h.istFremdeSeite(req({ origin: 'https://boese.de', host: 'a.de' })), true);
    assert.equal(h.istFremdeSeite(req({ origin: 'null', host: 'a.de' })), true);
  });

  test('eigene Seite und Anfragen ohne Browser-Header gehen durch', () => {
    assert.equal(h.istFremdeSeite(req({ 'sec-fetch-site': 'same-origin', origin: 'https://a.de', host: 'a.de' })), false);
    assert.equal(h.istFremdeSeite(req({ host: 'a.de' })), false);
  });
});

describe('Parallelität', () => {
  test('pro IP nur eine, global höchstens n', () => {
    const p = new h.Parallelitaet({ global: 2, proIp: 1 });
    const a = p.belegen('a');
    assert.ok(a);
    assert.equal(p.belegen('a'), null, 'Zweite Analyse derselben IP muss warten');
    const b = p.belegen('b');
    assert.ok(b);
    assert.equal(p.belegen('c'), null, 'Global voll');
    a();
    a(); // doppelte Freigabe darf nichts verbiegen
    assert.ok(p.belegen('c'));
    assert.equal(p.laufend, 2);
  });
});

describe('CSP', () => {
  test('erlaubt kein unsafe-inline und kein unsafe-eval', () => {
    const csp = h.cspFuer('abc');
    assert.doesNotMatch(csp, /'unsafe-inline'/);
    assert.doesNotMatch(csp, /'unsafe-eval'/);
    assert.match(csp, /'nonce-abc'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'none'/);
  });
});

describe('Turnstile', () => {
  let srv;
  let url;
  let antwort = {};

  before(async () => {
    srv = createServer((q, r) => {
      if (antwort === 'haengt') return;
      r.writeHead(200, { 'Content-Type': 'application/json' });
      r.end(JSON.stringify(antwort));
    });
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    url = `http://127.0.0.1:${srv.address().port}/siteverify`;
  });
  after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));

  const pruefe = (extra = {}) => h.pruefeTurnstile({ token: 'tok', secret: 's', ip: '1.2.3.4', verifyUrl: url, ...extra });

  test('gültiges Token', async () => {
    antwort = { success: true, hostname: 'datedecoder.backsafe.de', action: 'analyse' };
    assert.equal((await pruefe({ hostname: 'datedecoder.backsafe.de' })).ok, true);
  });

  test('abgelehnt, falscher Host, falsche Aktion, fehlendes Token', async () => {
    antwort = { success: false, 'error-codes': ['invalid-input-response'] };
    assert.equal((await pruefe()).ok, false);
    antwort = { success: true, hostname: 'boese.de' };
    assert.equal((await pruefe({ hostname: 'datedecoder.backsafe.de' })).ok, false);
    antwort = { success: true, action: 'login' };
    assert.equal((await pruefe()).ok, false);
    assert.equal((await pruefe({ token: '' })).ok, false);
  });

  test('Cloudflare nicht erreichbar -> gilt als nicht bestanden (fail closed)', async () => {
    const r = await h.pruefeTurnstile({ token: 'tok', secret: 's', verifyUrl: 'http://127.0.0.1:1/siteverify' });
    assert.equal(r.ok, false);
  });
});
