FROM node:20-alpine

WORKDIR /app

# Ohne production-Modus liefert Expresss Default-Error-Handler bei Bodies über
# 1 MB einen Stacktrace mit Container-Pfaden direkt an den Browser.
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js prompt.js ./
COPY public/ public/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
