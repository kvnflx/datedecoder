// Schutzschichten für die öffentliche Seite (2026-11-25, Kevins Auftrag "so stark
// wie möglich härten"). Jede Schicht ist einzeln testbar, server.js setzt sie
// zusammen. Hintergrund der Befunde:
//   - Die App war direkt über die Server-IP erreichbar, an Cloudflare vorbei.
//     Dort ließ sich cf-connecting-ip fälschen und das IP-Limit umgehen.
//   - Keine Security-Header, Express verriet sich per x-powered-by.
//   - Jede Analyse kostet Geld, automatisierte Anfragen leeren das Tagesbudget.
const crypto = require('crypto');
const net = require('net');

// ── Security-Header ────────────────────────────────────────────────────────

/**
 * CSP so eng wie möglich. Erlaubt sind nur:
 *   - eigene Dateien ('self')
 *   - cdn.jsdelivr.net: Tesseract (Skript mit Integritätsprüfung, Worker-Code,
 *     WASM-Kern und Sprachdaten, alles in tesseract.js 5.1.1 fest verdrahtet)
 *   - challenges.cloudflare.com: Turnstile
 *   - die Nonce: Cloudflare schleust ein Inline-Skript zur Bot-Erkennung ein und
 *     übernimmt dafür die Nonce aus diesem Header
 * 'wasm-unsafe-eval' braucht Tesseract für WebAssembly, blob: für seinen Worker.
 */
function cspFuer(nonce) {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://challenges.cloudflare.com`,
    "worker-src 'self' blob:",
    "connect-src 'self' https://cdn.jsdelivr.net https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "img-src 'self' blob: data:",
    "style-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests'
  ].join('; ');
}

function sicherheitsHeader(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  res.setHeader('Content-Security-Policy', cspFuer(nonce));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), ' +
      'magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=()'
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  // HSTS setzt Cloudflare bereits, ein zweiter Header wäre nur widersprüchlich.
  next();
}

// ── Herkunft: nur über Cloudflare ──────────────────────────────────────────

// Stand 2026-11-25 von https://api.cloudflare.com/client/v4/ips. Beim Start wird
// die Liste zusätzlich frisch geladen und ergänzt (ladeCloudflareNetze).
const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
];
const CLOUDFLARE_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32'
];

const cloudflareNetze = new net.BlockList();
const bekannteNetze = new Set();

function netzHinzufuegen(cidr) {
  if (bekannteNetze.has(cidr)) return;
  const [adresse, laenge] = cidr.split('/');
  const typ = net.isIPv6(adresse) ? 'ipv6' : 'ipv4';
  cloudflareNetze.addSubnet(adresse, Number(laenge), typ);
  bekannteNetze.add(cidr);
}
[...CLOUDFLARE_V4, ...CLOUDFLARE_V6].forEach(netzHinzufuegen);

/** Lädt die aktuelle Netzliste nach. Fehler sind unkritisch, die eingebaute Liste bleibt. */
async function ladeCloudflareNetze() {
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4/ips', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    const vorher = bekannteNetze.size;
    for (const c of [...(j.result?.ipv4_cidrs || []), ...(j.result?.ipv6_cidrs || [])]) netzHinzufuegen(c);
    console.log(`Cloudflare-Netze: ${bekannteNetze.size} (${bekannteNetze.size - vorher} neu geladen)`);
  } catch (err) {
    console.warn(`Cloudflare-Netze nicht nachladbar, eingebaute Liste gilt: ${err.message}`);
  }
}

function istCloudflareIp(ip) {
  if (!ip) return false;
  const roh = ip.startsWith('::ffff:') ? ip.slice(7) : ip; // IPv4 in IPv6-Schreibweise
  if (net.isIPv4(roh)) return cloudflareNetze.check(roh, 'ipv4');
  if (net.isIPv6(roh)) return cloudflareNetze.check(roh, 'ipv6');
  return false;
}

/**
 * Die IP, die tatsächlich mit dem Reverse Proxy verbunden war. Traefik läuft in
 * Coolify ohne forwardedHeaders-Vertrauen (auf dem Server geprüft): Es verwirft
 * mitgeschickte X-Forwarded-For-Header und hängt den echten Peer an. Der letzte
 * Eintrag ist damit nicht fälschbar. Ohne Proxy (lokal, Tests) gilt der Socket.
 */
function peerIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    const teile = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (teile.length) return teile[teile.length - 1];
  }
  return req.socket?.remoteAddress || '';
}

function gleichSicher(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Prüft, ob eine Anfrage über Cloudflare kam: Der Peer muss in Cloudflares Netzen
 * liegen, und, falls ORIGIN_SECRET gesetzt ist, muss der geheime Header passen,
 * den eine Cloudflare-Transform-Regel nur für datedecoder.backsafe.de setzt. Die
 * IP-Prüfung allein reicht nicht ganz, weil jeder Cloudflare-Kunde Anfragen über
 * Cloudflare-IPs an fremde Server schicken kann. Den Header kennt nur unsere Zone.
 */
function herkunft(req, origingeheimnis) {
  const peer = peerIp(req);
  const vonCloudflare = istCloudflareIp(peer);
  const geheimnisOk = !origingeheimnis || gleichSicher(req.headers['x-dd-origin'] || '', origingeheimnis);
  return { peer, vonCloudflare, geheimnisOk, ok: vonCloudflare && geheimnisOk };
}

/**
 * Client-IP für das Tageslimit. cf-connecting-ip gilt nur, wenn die Anfrage
 * nachweislich über Cloudflare kam; sonst die echte Peer-IP.
 */
function clientIp(req, herkunftInfo) {
  if (herkunftInfo.ok) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
  }
  return herkunftInfo.peer || 'unbekannt';
}

// ── Browser-Herkunft (CSRF und fremde Seiten) ──────────────────────────────

/**
 * Lehnt Anfragen ab, die ein Browser von einer fremden Seite aus schickt. Ohne
 * diese Prüfung könnte eine fremde Seite die Browser ihrer Besucher als Botnetz
 * nutzen, jeder mit eigener IP und damit eigenem Kontingent.
 */
function istFremdeSeite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return true;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return true;
    } catch {
      return true;
    }
  }
  return false;
}

// ── Parallelität ───────────────────────────────────────────────────────────

/** Höchstens `global` Analysen gleichzeitig, und pro IP höchstens `proIp`. */
class Parallelitaet {
  constructor({ global, proIp }) {
    this.global = global;
    this.proIp = proIp;
    this.laufend = 0;
    this.proIpLaufend = new Map();
  }

  /** Belegt einen Platz. Gibt eine Freigabe-Funktion zurück oder null, wenn voll. */
  belegen(ip) {
    const n = this.proIpLaufend.get(ip) || 0;
    if (this.laufend >= this.global || n >= this.proIp) return null;
    this.laufend++;
    this.proIpLaufend.set(ip, n + 1);
    let frei = false;
    return () => {
      if (frei) return;
      frei = true;
      this.laufend--;
      const m = (this.proIpLaufend.get(ip) || 1) - 1;
      if (m <= 0) this.proIpLaufend.delete(ip);
      else this.proIpLaufend.set(ip, m);
    };
  }
}

// ── Turnstile ──────────────────────────────────────────────────────────────

/**
 * Prüft ein Turnstile-Token bei Cloudflare. Fail closed: Ist Cloudflare nicht
 * erreichbar, gilt die Prüfung als nicht bestanden. Tokens sind einmalig gültig.
 */
async function pruefeTurnstile({ token, secret, ip, hostname, verifyUrl }) {
  if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, grund: 'kein Token' };
  try {
    const r = await fetch(verifyUrl || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip || '' }),
      signal: AbortSignal.timeout(5000)
    });
    const j = await r.json();
    if (j.success !== true) return { ok: false, grund: `abgelehnt: ${(j['error-codes'] || []).join(',')}` };
    if (hostname && j.hostname && j.hostname !== hostname) return { ok: false, grund: `falscher Host ${j.hostname}` };
    if (j.action && j.action !== 'analyse') return { ok: false, grund: `falsche Aktion ${j.action}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, grund: `nicht erreichbar: ${err.message}` };
  }
}

module.exports = {
  cspFuer,
  sicherheitsHeader,
  ladeCloudflareNetze,
  istCloudflareIp,
  peerIp,
  herkunft,
  clientIp,
  istFremdeSeite,
  Parallelitaet,
  pruefeTurnstile
};
