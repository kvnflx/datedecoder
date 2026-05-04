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
- **Modell-Fallback:** Falls `qwen/qwen3.5-122b-a10b` nicht antwortet (war beim Bauen ein Problem mit größeren Modellen wie DeepSeek V4), als Backup `meta/llama-3.3-70b-instruct` in `server.js` Zeile 30 setzen.

## Dateien

- `server.js` — Express Server mit /api/chat Streaming-Proxy
- `prompt.js` — Deutscher Dating-Master System-Prompt
- `public/index.html` — Landing + Chat UI
- `public/howto.html` — Anleitungen Chat-Export
- `public/style.css` — Dark Theme
- `public/app.js` — Chat-Logik, SSE, OCR
- `Dockerfile` — Node 20 Alpine
- `.env.example` — Vorlage für Environment-Variablen
