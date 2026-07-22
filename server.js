const express = require('express');
const path = require('path');
const systemPrompt = require('./prompt');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Die Kette verteilt sich bewusst über drei Anbieter. Am 2026-07-20 fielen
// 'qwen/qwen3.5-122b-a10b' (410 Gone, End of Life) und 'mistralai/mistral-large'
// (404, Function für den Account nicht mehr auflösbar) gleichzeitig aus — eine
// Kette aus einer Hand fängt so etwas nicht auf. Alle drei sind unter echter Last
// mit dem vollen System-Prompt gemessen; test/modelle.test.mjs prüft sie nach.
const MODELS = [
  'mistralai/mistral-small-4-119b-2603', // ~0,6 s bis zum ersten Token
  'google/gemma-4-31b-it',
  'meta/llama-3.3-70b-instruct' // langsam, aber in jedem Messlauf erreichbar
];

const NVIDIA_URL = process.env.NVIDIA_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
// 3 Modelle x 30 s = 90 s. Das muss unter Cloudflares Proxy-Read-Timeout bleiben,
// sonst kappt der Proxy die Verbindung mit einem 524, bevor der Server seinen
// eigenen 503 senden kann. test/modelle.test.mjs rechnet das Budget nach.
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS) || 30000;
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 90000; // ohne neue Daten im Stream

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Nachrichten-Array erforderlich.' });
  }

  const trimmed = messages.slice(-20);
  const fullMessages = [{ role: 'system', content: systemPrompt }, ...trimmed];

  let activeReader = null;
  // 'close' auf res, nicht auf req: req 'close' feuert bereits, sobald
  // express.json() den Body konsumiert hat — also lange vor einem echten Abbruch.
  res.on('close', () => {
    if (activeReader) activeReader.cancel().catch(() => {});
  });

  let ac = null;
  let watchdog = null;
  const clearWatchdog = () => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  try {
    let response = null;
    const attempts = [];

    for (const model of MODELS) {
      response = null; // sonst zeigt die Variable nach einer Exception noch auf die Antwort des Vormodells
      ac = new AbortController();
      watchdog = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS);

      try {
        const r = await fetch(NVIDIA_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`
          },
          body: JSON.stringify({ model, messages: fullMessages, stream: true, max_tokens: 4096 }),
          signal: ac.signal
        });

        clearWatchdog();

        if (r.ok) {
          response = r;
          console.log(`Using model: ${model}`);
          break;
        }

        // Der Fehler-Body ist die eigentliche Diagnose: NVIDIA nennt darin
        // Modellname und Abschaltdatum im Klartext. Ohne ihn ist der nächste
        // Ausfall wieder ein Blindflug.
        const detail = (await r.text().catch(() => '<Body nicht lesbar>')).slice(0, 300);
        attempts.push({ model, status: r.status, detail });
        console.warn(`Model ${model} -> HTTP ${r.status}: ${detail}`);
      } catch (err) {
        clearWatchdog();
        const detail = `${err.message} (${err.cause?.code ?? '-'})`;
        attempts.push({ model, status: 0, detail });
        console.warn(`Model ${model} fetch failed: ${detail}`);
      }
    }

    if (!response) {
      console.error('Alle Modelle fehlgeschlagen:', JSON.stringify(attempts));

      if (attempts.length && attempts.every((a) => a.status === 429)) {
        return res.status(429).json({ error: 'Zu viele Anfragen — kurz warten und nochmal versuchen.' });
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

    const reader = response.body.getReader();
    activeReader = reader;
    const decoder = new TextDecoder();

    let lastData = Date.now();
    let gesendet = 0;
    const armIdle = () => {
      clearWatchdog();
      watchdog = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS);
    };
    armIdle();

    // Heartbeat nur, wenn wirklich nichts fließt — sonst könnte der Ping zwischen
    // zwei Hälften einer fragmentierten SSE-Zeile landen und sie zerreißen.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && Date.now() - lastData >= 15000) res.write(': ping\n\n');
    }, 5000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
        gesendet += value.length;
        lastData = Date.now();
        armIdle();
      }
    } catch (err) {
      // Bricht der Stream ab, bevor irgendetwas geflossen ist, sähe der Browser
      // sonst nur ein leeres HTTP 200. Ein Fehler-Event im Stream ist ehrlicher.
      console.error('Stream abgebrochen:', err.message);
      if (gesendet === 0 && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: { message: 'Die Analyse wurde unterbrochen. Versuch es nochmal.' } })}\n\n`
        );
      }
    } finally {
      clearInterval(heartbeat);
      clearWatchdog();
      res.end();
    }
  } catch (err) {
    clearWatchdog();
    console.error('Handler-Fehler:', err.message, err.cause?.code ?? '');
    if (!res.headersSent) {
      // res.json() überschreibt einen bereits gesetzten Content-Type nicht,
      // deshalb hier explizit auf JSON zurücksetzen.
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(503).json({ error: 'Server gerade nicht erreichbar. Versuch\'s in ein paar Sekunden nochmal.' });
    } else {
      res.end();
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

// Ohne diesen Check baut der Handler klaglos den Header "Bearer undefined" und
// der Fehler endet als nichtssagender 503. Das trim() fängt ein per Copy-Paste
// in die Coolify-UI eingeschlepptes Newline ab, das fetch sonst mit
// "Invalid header value" quittiert.
const KEY = (process.env.NVIDIA_API_KEY || '').trim();
if (!KEY.startsWith('nvapi-')) {
  console.error('FATAL: NVIDIA_API_KEY fehlt oder hat unerwartetes Format (erwartet: nvapi-...).');
  process.exit(1);
}
process.env.NVIDIA_API_KEY = KEY;

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  console.log(`DateDecoder running on port ${PORT}, models: ${MODELS.join(', ')}`)
);

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
});
