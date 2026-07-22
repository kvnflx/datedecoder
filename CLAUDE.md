# DateDecoder — Anweisungen für Claude Code

## Projekt-Kontext

DateDecoder ist eine Dating-Chat-Analyse Web-App. User pasten Chatverläufe oder laden Screenshots/WhatsApp-Exporte hoch, eine LLM (Qwen 3.5-122B via NVIDIA NIM) analysiert in 4 Schichten (Pragmatik, Beziehungsdynamik, Signal-Check, Strategie) und gibt strukturierten deutschen Output zurück.

Tech-Stack: Vanilla HTML/CSS/JS Frontend, Express Backend, SSE-Streaming-Proxy zu NVIDIA NIM, Tesseract.js für browser-seitige OCR, Docker auf Coolify.

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
   - Environment Variable: **`NVIDIA_API_KEY`** = der API-Key des Users (am sichersten den User fragen, NICHT in Files committen)
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
  `mistralai/mistral-small-4-119b-2603` → `google/gemma-4-31b-it` → `meta/llama-3.3-70b-instruct`.
  Bewusst über drei Anbieter verteilt — siehe Vorfall unten.

## Vorfall 2026-07-20: Was schiefging und was daraus folgt

NVIDIA schaltete `qwen/qwen3.5-122b-a10b` zum 2026-07-20 ab (HTTP 410 Gone, End of Life).
Der einzige Fallback `mistralai/mistral-large` war zeitgleich für den Account nicht mehr
auflösbar (HTTP 404). Die Seite zeigte nur noch „Unbekannter Fehler". Daraus die Regeln:

- **Mindestens drei Modelle von mindestens zwei Anbietern.** Bei zwei Gliedern aus einer
  Hand genügt ein einzelner Anbieter-Rollout, um die App komplett zu killen.
- **Keine unversionierten Modell-Aliase.** `mistralai/mistral-large` ist so ein Alias —
  NVIDIA kann sein Ziel jederzeit still umhängen. Immer die versionierte ID nehmen.
- **Nie Status 502 oder 504 senden.** Cloudflare ersetzt beide durch eine eigene
  text/plain-Seite und verwirft den Body; die deutsche Fehlermeldung erreicht den Browser
  dann nie. 503 wird unverändert durchgereicht.
- **Timeout-Budget beachten.** `MODELS.length × CONNECT_TIMEOUT_MS` muss unter Cloudflares
  Proxy-Read-Timeout bleiben, sonst kappt der Proxy die Verbindung vor der eigenen
  Fehlerantwort. `test/modelle.test.mjs` rechnet das nach.
- **Fehler-Body des Upstreams immer loggen.** NVIDIA nennt darin Modellname und
  Abschaltdatum im Klartext. Ohne dieses Log war der Ausfall zwei Tage lang ein Blindflug.

## Tests

```bash
npm test                                    # Mock-Upstream, kein API-Key nötig
NVIDIA_API_KEY=nvapi-... npm run test:live  # prüft die Modell-Kette gegen NVIDIA
```

`test/modelle.test.mjs` ist der Frühwarner: Er schlägt an, sobald ein Modell der Kette
nicht mehr mit HTTP 200 antwortet — idealerweise bevor Nutzer es merken. Sinnvoll als
regelmäßiger Job.

## Dateien

- `server.js` — Express Server mit /api/chat Streaming-Proxy
- `prompt.js` — Deutscher Dating-Master System-Prompt
- `public/index.html` — Landing + Chat UI
- `public/howto.html` — Anleitungen Chat-Export
- `public/style.css` — Dark Theme
- `public/app.js` — Chat-Logik, SSE, OCR
- `Dockerfile` — Node 20 Alpine
- `.env.example` — Vorlage für Environment-Variablen
