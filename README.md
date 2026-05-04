# DateDecoder

> Nachrichten entschlüsseln. Signale erkennen. Klarheit gewinnen.

Mobile-first Web-App für Dating-Chat-Analyse, basierend auf Pragmatik (Grice), Bindungstheorie (Bowlby/Gottman) und Signaltheorie (Spence). User pasten Chatverläufe, laden Screenshots oder WhatsApp-Exporte hoch und bekommen eine strukturierte 4-Schichten-Analyse.

## Tech-Stack

- **Frontend**: Vanilla HTML/CSS/JS (kein Framework)
- **Backend**: Node.js 20 + Express
- **LLM**: Qwen 3.5-122B via NVIDIA NIM (OpenAI-kompatibel)
- **OCR**: Tesseract.js (browser-seitig, deutsch + englisch)
- **Deployment**: Docker auf Coolify

## Lokale Entwicklung

```bash
npm install
NVIDIA_API_KEY="nvapi-..." npm start
# → http://localhost:3000
```

## Environment-Variablen

| Variable | Beschreibung | Pflicht |
|---|---|---|
| `NVIDIA_API_KEY` | API-Key von [build.nvidia.com](https://build.nvidia.com) | ✅ |
| `PORT` | Port des Servers (Default: 3000) | ❌ |

## Deployment auf Coolify

1. Repo auf GitHub pushen
2. Coolify → New Resource → Public Repository (oder GitHub App) → Repo verbinden
3. Build Pack: **Dockerfile**
4. Environment Variables setzen: `NVIDIA_API_KEY=nvapi-...`
5. Port: `3000`
6. Deploy

## Projektstruktur

```
.
├── Dockerfile              # Node 20 Alpine Image
├── server.js               # Express + SSE Streaming Proxy
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

Antwortet als Server-Sent Events (SSE) Stream im OpenAI-kompatiblen Format.

## Modell-Wahl

Wir nutzen `qwen/qwen3.5-122b-a10b` weil:
- Sehr stark multilingual (Deutsch + Chinesisch — Original-Skill ist Chinesisch)
- Gutes Reasoning für nuancierte Subtext-Analyse
- Sofort verfügbar auf NVIDIA NIM (kostenlos)
- Schnell genug für interaktiven Chat

Alternativen falls Modell ausfällt: `meta/llama-3.3-70b-instruct`, `nvidia/llama-3.3-nemotron-super-49b-v1.5`. Modellname steht in `server.js` Zeile 30.
