# DateDecoder

> Nachrichten entschlüsseln. Signale erkennen. Klarheit gewinnen.

Mobile-first Web-App für Dating-Chat-Analyse, basierend auf Pragmatik (Grice), Bindungstheorie (Bowlby/Gottman) und Signaltheorie (Spence). User pasten Chatverläufe, laden Screenshots oder WhatsApp-Exporte hoch und bekommen eine strukturierte 4-Schichten-Analyse.

## Tech-Stack

- **Frontend**: Vanilla HTML/CSS/JS (kein Framework)
- **Backend**: Node.js 24 + Express
- **LLM**: Claude Opus 5.5 über die Anthropic-API (Fallback: Sonnet 5.5, Haiku 5.5)
- **OCR**: Tesseract.js (browser-seitig, deutsch + englisch)
- **Deployment**: Docker auf Coolify

## Lokale Entwicklung

```bash
npm install
ANTHROPIC_API_KEY="sk-ant-..." npm start
# → http://localhost:3000
```

## Environment-Variablen

| Variable | Beschreibung | Pflicht |
|---|---|---|
| `ANTHROPIC_API_KEY` | API-Key von [console.anthropic.com](https://console.anthropic.com) | ✅ |
| `PORT` | Port des Servers (Default: 3000) | ❌ |
| `DAILY_REQUESTS_PER_IP` | Anfragen pro IP und Tag (Default: 2) | ❌ |
| `DAILY_BUDGET_USD` | Tagesbudget über alle Nutzer in USD (Default: 0.5) | ❌ |
| `EFFORT` | Denktiefe von Claude: low, medium, high (Default: medium) | ❌ |
| `CLOUDFLARE_PFLICHT` | `/api/chat` nur über Cloudflare: erzwingen, melden, aus (Default: erzwingen in Produktion, sonst aus) | ❌ |
| `ORIGIN_SECRET` | Geheimer Header `x-dd-origin`, den eine Cloudflare-Transform-Regel setzt | ❌ |
| `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET` | Turnstile vor jeder Analyse (nur beide zusammen) | ❌ |
| `TURNSTILE_HOSTNAME` | Erwarteter Hostname in der Turnstile-Antwort | ❌ |
| `MAX_PARALLEL` | Gleichzeitige Analysen insgesamt (Default: 4, pro IP immer 1) | ❌ |

## Deployment auf Coolify

1. Repo auf GitHub pushen
2. Coolify → New Resource → Public Repository (oder GitHub App) → Repo verbinden
3. Build Pack: **Dockerfile**
4. Environment Variables setzen: `ANTHROPIC_API_KEY=sk-ant-...`
5. Port: `3000`
6. Deploy

## Projektstruktur

```
.
├── Dockerfile              # Node 24 Alpine Image
├── server.js               # Express + SSE Streaming Proxy zur Anthropic-API
├── limits.js               # Kostenbremse: Limit pro IP, Tagesbudget
├── haertung.js             # Schutzschichten: CSP, Cloudflare-Herkunft, Turnstile
├── prompt.js               # Deutscher Dating-Master System-Prompt
├── package.json
└── public/
    ├── index.html          # Landing + Chat Mode
    ├── howto.html          # Anleitungen für Chat-Export
    ├── style.css           # Dark Theme, mobile-first
    └── app.js              # Chat-Logik, Streaming, OCR
```

## API

`POST /api/chat`

```json
{
  "messages": [
    { "role": "user", "content": "Sie hat geschrieben: ..." }
  ]
}
```

Antwortet als Server-Sent Events (SSE) Stream. Der Server übersetzt die Claude-Events in das Chunk-Format, das `public/app.js` erwartet (`choices[0].delta.content`, Abschluss mit `data: [DONE]`). Fehler mitten im Stream kommen als `{"error":{"message":...}}`, Hinweise als `{"hinweis":...}`.

Vor dem Modellaufruf greift die Kostenbremse: höchstens 2 Anfragen pro IP und Tag und ein Tagesbudget, abgerechnet nach den echten Token-Kosten. Beides antwortet mit HTTP 429 und `Retry-After` bis Mitternacht UTC.

## Modell-Wahl

Seit 2026-11-25 läuft DateDecoder auf Claude. Vorher NVIDIA NIM: Dort wurden binnen vier Monaten alle Modelle der Kette abgeschaltet (410 Gone) und zuletzt der Key entwertet (403), die Seite war zweimal komplett down.

- `claude-opus-5-5` (Hauptmodell): bestes Gespür für Subtext, gemessen ~8 Cent und ~35 s pro Analyse
- `claude-sonnet-5-5`: springt bei Überlast oder Ausfall ein
- `claude-haiku-5-5`: letzte Reserve, deutlich flacher in der Deutung

Die Kette steht in `server.js` als `MODELS`. `ANTHROPIC_API_KEY=... npm run test:live` prüft kostenlos über die Models-API, ob alle drei noch verfügbar sind.
