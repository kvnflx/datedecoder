const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const systemPrompt = require('./prompt');
const { kostenUsd, sekundenBisMorgen, TagesLimit, TagesBudget } = require('./limits');

// Ohne diesen Check startet der Server klaglos und jeder Request endet als
// nichtssagender 503. Das trim() fängt ein per Copy-Paste in die Coolify-UI
// eingeschlepptes Newline ab, das sonst als "Invalid header value" scheitert.
const KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
if (!KEY.startsWith('sk-ant-')) {
  console.error('FATAL: ANTHROPIC_API_KEY fehlt oder hat unerwartetes Format (erwartet: sk-ant-...).');
  process.exit(1);
}

// Seit 2026-11-25 Claude statt NVIDIA NIM. NVIDIA hatte binnen vier Monaten jedes
// Modell der Kette abgeschaltet (410 Gone, zuletzt google/gemma-4-31b-it am
// 2026-11-24) und den Key entwertet (403). Die Kette bleibt bewusst bei einem
// Anbieter: Anthropic kündigt Abschaltungen mit Vorlauf an, und jedes Modell hat
// ein eigenes Rate-Limit, sodass Überlast beim einen auf das nächste ausweicht.
// test/modelle.test.mjs prüft die Kette gegen die Models-API.
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

// Lehnt ein Modell die Anfrage ab (HTTP 200 mit stop_reason "refusal"), wiederholt
// die API sie serverseitig auf einem passenden Modell. Haiku 5.5 kennt das nicht.
const MIT_REFUSAL_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

// Gemessen mit dem echten Prompt (2026-11-25, Opus 5.5): ~3.500 Ausgabe-Tokens
// inklusive Denken, erstes Wort nach ~6 s. 16.000 lässt Luft und deckelt die Kosten.
const EFFORT = process.env.EFFORT || 'medium';
const MAX_TOKENS = 16000;

// 3 Modelle x 30 s = 90 s. Das muss unter Cloudflares Proxy-Read-Timeout bleiben,
// sonst kappt der Proxy die Verbindung mit einem 524, bevor der Server seinen
// eigenen 503 senden kann. test/modelle.test.mjs rechnet das Budget nach.
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS) || 30000;
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 90000; // ohne neue Daten im Stream

// Längere Verläufe werden auf die neuesten Nachrichten gekürzt. Die Grenze ist
// eine Kostenfrage, keine des Kontextfensters (1 Mio. Tokens): 60 KB sind etwa
// 30.000 Tokens, gut 12 Cent Eingabe bei Opus 5.5, und immer noch die neuesten
// rund 800 WhatsApp-Nachrichten. Mit den früheren 200 KB hätte eine einzige
// Anfrage das Tagesbudget von 0,50 USD gesprengt.
const MAX_CHAT_BYTES = Number(process.env.MAX_CHAT_BYTES) || 60 * 1024;
// Obergrenze für den gesamten Gesprächsverlauf inklusive Nachfragen. Ohne sie
// könnten 20 lange Nachrichten in einer einzigen Anfrage landen.
const MAX_GESAMT_BYTES = Number(process.env.MAX_GESAMT_BYTES) || 100 * 1024;

// Kostenbremse, siehe limits.js. Kevins Vorgabe (2026-11-25): 2 Anfragen pro IP
// und Tag, höchstens 0,50 EUR am Tag. Das Budget rechnet in USD; 0,50 USD liegen
// unter 0,50 EUR. Bei ~8,5 Cent pro Opus-Analyse reicht das für 5 bis 6 am Tag.
const limitProIp = new TagesLimit({ max: Number(process.env.DAILY_REQUESTS_PER_IP) || 2 });
const budget = new TagesBudget({ limitUsd: Number(process.env.DAILY_BUDGET_USD) || 0.5 });
// Reserve für die Ausgabe bei der Budget-Schätzung (gemessen ~3.500, eher zu hoch angesetzt).
const AUSGABE_RESERVE_TOKENS = 6000;

const client = new Anthropic({
  apiKey: KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  // Die Modell-Kette ist das Retry. SDK-Retries obendrauf würden das
  // Timeout-Budget unter Cloudflares 100 Sekunden sprengen.
  maxRetries: 0
});

const app = express();
// Großzügig, damit auch ein mehrjähriger WhatsApp-Export (~1,6 MB) ankommt.
// Zu lange Verläufe werden nicht abgelehnt, sondern gekürzt — siehe kuerzeVerlauf().
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** 12463 -> "12.463" — deterministisch, unabhängig von der ICU-Ausstattung des Images. */
function zahl(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Kürzt einen überlangen Verlauf auf die NEUESTEN Nachrichten. Für eine
 * Dating-Analyse zählt die aktuelle Dynamik — was vor drei Jahren geschrieben
 * wurde, verwässert das Ergebnis eher, als dass es hilft.
 * Geschnitten wird an Zeilengrenzen, damit keine Nachricht zerrissen wird.
 */
function kuerzeVerlauf(text) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_CHAT_BYTES) {
    return { text, gekuerzt: false };
  }

  const zeilen = text.split('\n');
  const gesamt = zeilen.filter((z) => z.trim()).length;

  const behalten = [];
  let summe = 0;
  for (let i = zeilen.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(zeilen[i], 'utf8') + 1;
    if (summe + b > MAX_CHAT_BYTES) break;
    behalten.unshift(zeilen[i]);
    summe += b;
  }

  // Fallback für Texte ohne Zeilenumbrüche (z. B. OCR am Stück): hart schneiden.
  if (behalten.length === 0) {
    const roh = Buffer.from(text, 'utf8').subarray(-MAX_CHAT_BYTES).toString('utf8');
    return { text: roh, gekuerzt: true, gesamt, uebrig: 0 };
  }

  return {
    text: behalten.join('\n'),
    gekuerzt: true,
    gesamt,
    uebrig: behalten.filter((z) => z.trim()).length
  };
}

/**
 * Lässt nur Text-Nachrichten von "user" und "assistant" durch. Eine eingeschleuste
 * role "system" wäre bei Claude eine echte Operator-Anweisung mitten im Gespräch,
 * die den System-Prompt aushebeln könnte. Liefert null bei ungültiger Eingabe.
 */
function bereinigeNachrichten(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
  }
  // Leere Antworten (z. B. nach einem Abbruch) würde die API mit 400 ablehnen.
  const sauber = messages
    .filter((m) => m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));
  // Die API verlangt eine user-Nachricht am Anfang und (ohne Prefill) am Ende.
  while (sauber.length && sauber[0].role !== 'user') sauber.shift();
  if (!sauber.length || sauber[sauber.length - 1].role !== 'user') return null;
  return sauber;
}

/**
 * Client-IP hinter Cloudflare und Traefik. Wer am Proxy vorbei direkt den Origin
 * anspricht, kann die Header fälschen und das IP-Limit umgehen. Dagegen hilft das
 * Tagesbudget, das unabhängig von der IP greift.
 */
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unbekannt';
}

/** Grobe Kostenschätzung vor der Anfrage. Deutsch mit Umlauten: ~2 Byte pro Token (gemessen). */
function schaetzeKostenUsd(model, eingabeBytes) {
  return kostenUsd(model, {
    input_tokens: Math.ceil(eingabeBytes / 2),
    output_tokens: AUSGABE_RESERVE_TOKENS
  });
}

/** Erkennt, ob der Upstream wegen Überlänge abgelehnt hat — nicht wegen Ausfalls. */
function istKontextFehler(status, detail) {
  return (
    status === 400 &&
    /prompt is too long|context length|context window|input tokens|too long|maximum context/i.test(detail)
  );
}

/** Status und Klartext eines SDK-Fehlers fürs Log. Netzwerk- und Abbruchfehler haben keinen Status. */
function fehlerInfo(err) {
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return { status: err.status, detail: String(err.message).slice(0, 300) };
  }
  return { status: 0, detail: `${err.name}: ${err.message} (${err.cause?.code ?? '-'})` };
}

/** Übernimmt nur echte Zahlen; message_delta liefert manche Felder als null. */
function mergeUsage(ziel, quelle) {
  for (const [k, v] of Object.entries(quelle || {})) {
    if (typeof v === 'number') ziel[k] = v;
  }
}

app.post('/api/chat', async (req, res) => {
  const bereinigt = bereinigeNachrichten(req.body?.messages);
  if (!bereinigt) {
    return res.status(400).json({ error: 'Ungültiger Gesprächsverlauf.' });
  }

  // Überlange Einzelnachrichten (typisch: der importierte Verlauf) kürzen,
  // statt sie erst ans Modell zu schicken und dort zu bezahlen.
  let hinweis = null;
  const nachrichten = bereinigt.map((m) => {
    const k = kuerzeVerlauf(m.content);
    if (!k.gekuerzt) return m;
    hinweis =
      `Der Verlauf war sehr lang. Analysiert wurden die neuesten ${zahl(k.uebrig)} ` +
      `von ${zahl(k.gesamt)} Nachrichten — die aktuellsten sind für die Einschätzung ` +
      'die aussagekräftigsten.';
    console.log(`Verlauf gekürzt: ${zahl(k.gesamt)} -> ${zahl(k.uebrig)} Nachrichten`);
    return { ...m, content: k.text };
  });

  const eingabeBytes =
    Buffer.byteLength(systemPrompt, 'utf8') +
    nachrichten.reduce((s, m) => s + Buffer.byteLength(m.content, 'utf8'), 0);
  if (eingabeBytes > MAX_GESAMT_BYTES) {
    return res.status(413).json({
      error: 'Das Gespräch ist zu lang geworden. Starte eine neue Analyse mit dem aktuellen Verlauf.'
    });
  }

  // Erst das IP-Kontingent, dann das Budget. Wer heute schon dran war, soll keine
  // Budget-Reservierung auslösen, die anderen den Platz wegnimmt.
  const ip = clientIp(req);
  if (!limitProIp.nehmen(ip)) {
    res.setHeader('Retry-After', String(sekundenBisMorgen(Date.now())));
    return res.status(429).json({
      error: `Du hast heute schon ${limitProIp.max} Analysen gemacht. Morgen geht es weiter.`
    });
  }
  const reservierung = budget.reservieren(schaetzeKostenUsd(MODELS[0], eingabeBytes));
  if (!reservierung) {
    limitProIp.zurueckgeben(ip);
    const s = budget.stand();
    console.warn(`Tagesbudget erschöpft: $${s.ausgegeben.toFixed(4)} ausgegeben, $${s.reserviert.toFixed(4)} reserviert`);
    res.setHeader('Retry-After', String(sekundenBisMorgen(Date.now())));
    return res.status(429).json({
      error: 'Das Tageskontingent von DateDecoder ist aufgebraucht. Morgen geht es weiter.'
    });
  }

  let ac = null;
  let watchdog = null;
  const clearWatchdog = () => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };
  // 'close' auf res, nicht auf req: req 'close' feuert bereits, sobald
  // express.json() den Body konsumiert hat — also lange vor einem echten Abbruch.
  res.on('close', () => {
    if (ac) ac.abort();
  });

  const usage = {};
  let modell = MODELS[0];
  let usageVollstaendig = false; // erst message_delta liefert die Ausgabe-Tokens
  let textGesendet = false;

  try {
    let stream = null;
    const attempts = [];

    for (const model of MODELS) {
      ac = new AbortController();
      watchdog = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS);

      const params = {
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: nachrichten,
        output_config: { effort: EFFORT },
        stream: true
      };
      if (MIT_REFUSAL_FALLBACK.has(model)) {
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
      }

      try {
        stream = await client.beta.messages.create(params, { signal: ac.signal });
        clearWatchdog();
        modell = model;
        console.log(`Using model: ${model}`);
        break;
      } catch (err) {
        clearWatchdog();
        // Der Fehler-Body ist die eigentliche Diagnose (Modellname, Grund). Ohne
        // ihn wäre der nächste Ausfall wieder ein Blindflug wie am 2026-07-20.
        const info = fehlerInfo(err);
        attempts.push({ model, ...info });
        console.warn(`Model ${model} -> HTTP ${info.status}: ${info.detail}`);
        // Ein ungültiger oder gesperrter Key gilt für jedes Modell der Kette.
        if (info.status === 401 || info.status === 403) break;
        if (res.destroyed) break; // Nutzer ist schon weg
      }
    }

    if (!stream) {
      limitProIp.zurueckgeben(ip);
      budget.abrechnen(reservierung, 0);
      console.error('Alle Modelle fehlgeschlagen:', JSON.stringify(attempts));

      if (attempts.length && attempts.every((a) => a.status === 429)) {
        return res.status(429).json({ error: 'Zu viele Anfragen — kurz warten und nochmal versuchen.' });
      }
      // Lehnen alle Modelle wegen Überlänge ab, ist der Server erreichbar und
      // die Meldung "nicht erreichbar" schlicht falsch.
      if (attempts.length && attempts.every((a) => istKontextFehler(a.status, a.detail))) {
        return res.status(413).json({
          error: 'Der Chatverlauf ist zu lang für die Analyse. Kürze ihn oder teile ihn auf.'
        });
      }
      // 503 statt 502: Cloudflare ersetzt Origin-502 und -504 durch eine eigene
      // text/plain-Seite und verwirft den Body. 503 wird unverändert durchgereicht —
      // nur so erreicht diese Meldung überhaupt den Browser.
      return res
        .status(503)
        .json({ error: 'Server gerade nicht erreichbar. Versuch\'s in ein paar Sekunden nochmal.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // verhindert Puffern durch Reverse Proxies
    res.flushHeaders();

    let lastWrite = Date.now();
    const schreibe = (daten) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`data: ${JSON.stringify(daten)}\n\n`);
      lastWrite = Date.now();
    };

    // Transparenz vor der Analyse: Wurde gekürzt, muss der Nutzer das wissen —
    // sonst zieht er Schlüsse aus einer unvollständigen Grundlage.
    if (hinweis) schreibe({ hinweis });

    const armIdle = () => {
      clearWatchdog();
      watchdog = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS);
    };
    armIdle();

    // Opus denkt vor der ersten sichtbaren Zeile ein paar Sekunden. Der Ping hält
    // die Verbindung durch Cloudflare offen und wird nur gesendet, wenn wirklich
    // nichts fließt, damit er nie zwischen zwei Teile eines Events gerät.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && Date.now() - lastWrite >= 15000) {
        res.write(': ping\n\n');
        lastWrite = Date.now();
      }
    }, 5000);

    let stopReason = null;
    try {
      for await (const ev of stream) {
        armIdle();
        if (ev.type === 'message_start') {
          modell = ev.message.model || modell;
          mergeUsage(usage, ev.message.usage);
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) {
          // Das Frontend versteht das Chunk-Format aus NVIDIA-Zeiten. Es bleibt,
          // damit public/app.js und der Cloudflare-Cache unberührt bleiben.
          schreibe({ choices: [{ delta: { content: ev.delta.text } }] });
          textGesendet = true;
        } else if (ev.type === 'message_delta') {
          mergeUsage(usage, ev.usage);
          usageVollstaendig = true;
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        }
      }

      // Das SDK beendet die Schleife bei einem Abbruch (Idle-Timeout, Nutzer weg)
      // still, ohne Exception. Ohne diese Prüfung käme eine leere Analyse mit 200 an.
      if (!stopReason) {
        throw new Error(ac.signal.aborted ? 'Timeout oder Abbruch ohne Abschluss' : 'Stream ohne Abschluss beendet');
      }

      if (stopReason === 'refusal') {
        // Auch der Fallback hat abgelehnt. Ohne Meldung stünde ein leerer Kasten da.
        console.warn(`Anfrage abgelehnt (refusal), Modell ${modell}`);
        if (!textGesendet) limitProIp.zurueckgeben(ip);
        schreibe({ error: { message: 'Diese Anfrage kann nicht analysiert werden. Formuliere sie anders.' } });
      } else if (stopReason === 'max_tokens') {
        schreibe({ hinweis: 'Die Antwort wurde an der Längengrenze abgeschnitten.' });
      }
      if (!res.writableEnded && !res.destroyed) res.write('data: [DONE]\n\n');
    } catch (err) {
      // Bricht der Stream ab, bevor irgendetwas geflossen ist, sähe der Browser
      // sonst nur ein leeres HTTP 200. Ein Fehler-Event im Stream ist ehrlicher.
      console.error('Stream abgebrochen:', fehlerInfo(err).detail);
      if (!textGesendet) {
        limitProIp.zurueckgeben(ip);
        schreibe({ error: { message: 'Die Analyse wurde unterbrochen. Versuch es nochmal.' } });
      } else {
        schreibe({ hinweis: 'Die Analyse wurde unterbrochen und ist unvollständig.' });
      }
    } finally {
      clearInterval(heartbeat);
      clearWatchdog();
      res.end();
    }
  } catch (err) {
    clearWatchdog();
    limitProIp.zurueckgeben(ip);
    console.error('Handler-Fehler:', err.message, err.cause?.code ?? '');
    if (!res.headersSent) {
      // res.json() überschreibt einen bereits gesetzten Content-Type nicht,
      // deshalb hier explizit auf JSON zurücksetzen.
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(503).json({ error: 'Server gerade nicht erreichbar. Versuch\'s in ein paar Sekunden nochmal.' });
    } else {
      res.end();
    }
  } finally {
    // Ohne vollständige Usage (Abbruch mitten im Stream) zählt die Reservierung,
    // lieber zu hoch als ein Loch im Budget. Ohne Stream ist schon abgerechnet.
    const kosten = usageVollstaendig ? kostenUsd(modell, usage) : reservierung.betrag;
    budget.abrechnen(reservierung, kosten);
    if (usageVollstaendig) {
      const s = budget.stand();
      console.log(
        `Analyse: ${modell}, in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'}, ` +
          `$${kosten.toFixed(4)}, heute $${s.ausgegeben.toFixed(4)} von $${s.limit}`
      );
    }
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true, models: MODELS }));

// Error-Handler gehören hinter alle Routen. Ohne ihn antwortet Express bei zu
// großen Bodies mit einem HTML-Stacktrace statt JSON — ein zweiter Weg zu
// "Unbekannter Fehler", und im Development-Modus zusätzlich ein Informationsleck.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Der Chatverlauf ist zu groß. Kürze ihn oder teile ihn auf.' });
  }
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({ error: 'Ungültige Anfrage.' });
  }
  console.error('Unbehandelter Fehler:', err);
  return res.status(500).json({ error: 'Serverfehler.' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  console.log(
    `DateDecoder running on port ${PORT}, models: ${MODELS.join(', ')}, ` +
      `Limit ${limitProIp.max}/IP/Tag, Budget $${budget.limitUsd}/Tag`
  )
);

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
});
