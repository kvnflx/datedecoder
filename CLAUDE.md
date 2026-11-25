# DateDecoder — Anweisungen für Claude Code

## Projekt-Kontext

DateDecoder ist eine Dating-Chat-Analyse Web-App. User pasten Chatverläufe oder laden Screenshots/WhatsApp-Exporte hoch, Claude Opus 5.5 über die Anthropic-API analysiert in 4 Schichten (Pragmatik, Beziehungsdynamik, Signal-Check, Strategie) und gibt strukturierten deutschen Output zurück.

Tech-Stack: Vanilla HTML/CSS/JS Frontend, Express Backend (Node 24), SSE-Streaming-Proxy zur Anthropic-API (`@anthropic-ai/sdk`), Tesseract.js für browser-seitige OCR, Docker auf Coolify.

Live: https://datedecoder.backsafe.de (Coolify-App `wbestwdcxzqsjaabgzjofaq7`, Auto-Deploy per GitHub-Webhook auf `main`).

## Sprache

**Alles auf Deutsch.** UI, Kommunikation mit dem User, Commit-Messages, Code-Kommentare. Code-Identifier (Funktions-/Variablen-Namen) bleiben Englisch (Programmier-Konvention).

## Aufgabe

Der User möchte das Projekt:

1. **Auf GitHub pushen** — neues Repo erstellen, alles hochladen
2. **Auf Coolify deployen** — der User hat einen Coolify-Server. Coolify zieht das Repo, baut das Docker-Image und deployt

## Schritte

### 1. GitHub Push

```bash
# Im Projekt-Root
git remote add origin https://github.com/<username>/datedecoder.git
git branch -M main
git push -u origin main
```

Falls noch kein GitHub Repo existiert: User soll eins anlegen (oder via `gh repo create datedecoder --public --source=. --push` falls `gh` CLI installiert ist).

### 2. Coolify Deployment

User hat Coolify-MCP-Tools verfügbar (siehe `mcp__coolify__*` Tools). Damit:

1. Auflisten der Coolify-Server / Projekte zur Bestätigung mit dem User
2. Neue Application via Coolify-MCP anlegen:
   - Source: GitHub Repo (das gerade erstellte)
   - Build Pack: **Dockerfile**
   - Port: **3000**
   - Environment Variable: **`ANTHROPIC_API_KEY`** (KeePass: `KI-APIs/DateDecoder`, NICHT in Files committen)
3. Deploy auslösen
4. Domain/URL zurückgeben

### 3. Verifikation

Nach dem Deploy:
- Application-Logs prüfen: `DateDecoder running on port 3000`
- HTTP-Check auf die Coolify-URL
- User soll die App im Browser öffnen und einen Test-Chatverlauf analysieren

## Wichtig

- **API-Key niemals committen.** Er gehört nur in Coolify-Environment-Variables.
- **Existing Working Code:** Die App ist getestet und läuft. Mache keine Änderungen am Code, außer der User bittet darum.
- **Modell-Kette:** Steht in `server.js` im Modulscope als `MODELS`. Aktuell:
  `claude-opus-5-5` → `claude-sonnet-5-5` → `claude-haiku-5-5`, `effort: medium`.
  Opus/Sonnet laufen mit serverseitigem Refusal-Fallback (`fallbacks: "default"`).
- **Kostenbremse (`limits.js`):** Jede Anfrage kostet Geld, die Seite ist öffentlich.
  2 Anfragen pro IP und Tag, Tagesbudget 0,50 USD über alle Nutzer (Kevins Vorgabe
  2026-11-25: 0,50 EUR). Abgerechnet nach echten Tokens, vorher wird geschätzt und
  reserviert. Fehlgeschlagene Anfragen geben das IP-Kontingent zurück.
  `MAX_CHAT_BYTES` (60 KB) muss so klein bleiben, dass ein maximal großer Export
  ins Tagesbudget passt; ein Test in `test/fehlerpfad.test.mjs` prüft das.
- **Frontend-Stream-Format bleibt:** Der Server übersetzt Claude-Events in
  `choices[0].delta.content` + `data: [DONE]`. So bleibt `public/app.js` unberührt.

## Vorfall 2026-11-24: Wechsel von NVIDIA NIM zu Claude

Am 2026-11-24 schaltete NVIDIA mit `google/gemma-4-31b-it` das letzte noch lebende
Modell der Ersatzkette ab (410). `mistral-small-4` war schon seit 2026-07-27 tot,
`llama-3.3-70b` seit 2026-08-26, gemerkt hat es niemand. Zusätzlich bekam der
NVIDIA-Key bei allen übrigen Modellen 403. Entscheidung Kevin: Umstieg auf Claude,
Kette nur innerhalb von Anthropic. Die Regel "mindestens zwei Anbieter" unten
stammt aus NVIDIA-Zeiten und gilt nicht mehr: Anthropic kündigt Abschaltungen mit
Vorlauf an, und jedes Modell hat ein eigenes Rate-Limit.

Folgerung: `npm run test:live` (kostenlos, Models-API) regelmäßig laufen lassen.
Hätte das bei NVIDIA jemand getan, wäre der Ausfall Ende Juli aufgefallen.

## Vorfall 2026-07-20: Was schiefging und was daraus folgt

NVIDIA schaltete `qwen/qwen3.5-122b-a10b` zum 2026-07-20 ab (HTTP 410 Gone, End of Life).
Der einzige Fallback `mistralai/mistral-large` war zeitgleich für den Account nicht mehr
auflösbar (HTTP 404). Die Seite zeigte nur noch „Unbekannter Fehler". Daraus die Regeln:

- **Mindestens drei Modelle.** (Damals zusätzlich: von zwei Anbietern. Seit dem Wechsel
  zu Claude 2026-11-25 aufgehoben, siehe oben.)
- **Keine unversionierten Modell-Aliase.** `mistralai/mistral-large` ist so ein Alias —
  NVIDIA kann sein Ziel jederzeit still umhängen. Immer die versionierte ID nehmen.
- **Nie Status 502 oder 504 senden.** Cloudflare ersetzt beide durch eine eigene
  text/plain-Seite und verwirft den Body; die deutsche Fehlermeldung erreicht den Browser
  dann nie. 503 wird unverändert durchgereicht.
- **Timeout-Budget beachten.** `MODELS.length × CONNECT_TIMEOUT_MS` muss unter Cloudflares
  Proxy-Read-Timeout bleiben, sonst kappt der Proxy die Verbindung vor der eigenen
  Fehlerantwort. `test/modelle.test.mjs` rechnet das nach.
- **Fehler-Body des Upstreams immer loggen.** Darin stehen Modellname und Grund
  im Klartext. Ohne dieses Log war der Ausfall zwei Tage lang ein Blindflug.

## Tests

```bash
npm test                                        # Mock der Anthropic-API, kein Key nötig
ANTHROPIC_API_KEY=sk-ant-... npm run test:live  # prüft die Modell-Kette (kostenlos)
```

`test/modelle.test.mjs` ist der Frühwarner: Er schlägt an, sobald ein Modell der Kette
für den Account nicht mehr existiert — idealerweise bevor Nutzer es merken. Sinnvoll als
regelmäßiger Job.

## Dateien

- `server.js` — Express Server mit /api/chat Streaming-Proxy zur Anthropic-API
- `limits.js` — Kostenbremse (Limit pro IP und Tag, Tagesbudget, Preistabelle)
- `prompt.js` — Deutscher Dating-Master System-Prompt
- `public/index.html` — Landing + Chat UI
- `public/howto.html` — Anleitungen Chat-Export
- `public/style.css` — Dark Theme
- `public/app.js` — Chat-Logik, SSE, OCR
- `Dockerfile` — Node 24 Alpine
- `.env.example` — Vorlage für Environment-Variablen
