# Node 24 LTS: Das Anthropic-SDK unterstützt nur nicht-EOL-Versionen, Node 20 ist seit 2026-04 EOL.
FROM node:24-alpine

WORKDIR /app

# Ohne production-Modus liefert Expresss Default-Error-Handler bei Bodies über
# 1 MB einen Stacktrace mit Container-Pfaden direkt an den Browser. Außerdem
# schaltet production die Cloudflare-Pflicht für /api/chat ein (server.js).
ENV NODE_ENV=production

# --ignore-scripts: Keine Abhängigkeit braucht Install-Skripte (2026-11-26
# geprüft). So kann ein kompromittiertes Paket beim Build keinen Code ausführen.
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Dateien gehören root und sind für den App-Benutzer nur lesbar: Selbst ein
# erfolgreicher Angriff auf den Prozess kann den eigenen Code nicht verändern.
COPY server.js prompt.js limits.js haertung.js ./
COPY public/ public/

# Nicht als root laufen. Der Benutzer "node" ist im offiziellen Image angelegt.
# Zusätzlich setzt Coolify: --read-only, --cap-drop=ALL, no-new-privileges,
# Speicher- und Prozesslimit (siehe CLAUDE.md, Abschnitt Container).
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
