// Gemeinsame Bausteine für einen Mock der Anthropic Messages-API (POST /v1/messages).
// Der Server wird per ANTHROPIC_BASE_URL darauf umgeleitet, die Tests brauchen
// weder Key noch Guthaben.
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Sendet eine Fehlerantwort im Format der API. */
export function sendeFehler(res, status, typ, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: typ, message } }));
}

function event(res, typ, daten) {
  res.write(`event: ${typ}\ndata: ${JSON.stringify({ type: typ, ...daten })}\n\n`);
}

/**
 * Sendet einen vollständigen Stream. `texte` sind die Text-Deltas, `stopReason`
 * z. B. 'end_turn' oder 'refusal', `usage` die Token-Zahlen fürs Budget.
 */
export function sendeStream(res, { model, texte = [], stopReason = 'end_turn', usage = { input_tokens: 10, output_tokens: 10 } }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  event(res, 'message_start', {
    message: {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 1 }
    }
  });
  if (texte.length) {
    event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const text of texte) event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    event(res, 'content_block_stop', { index: 0 });
  }
  event(res, 'message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens }
  });
  event(res, 'message_stop', {});
  res.end();
}

/**
 * Startet den Mock. `antwort(anfrage, res)` entscheidet pro Request; `anfrage`
 * enthält den geparsten Body und die Header. Alle Anfragen landen in `anfragen`.
 */
export async function starteMock(antwort) {
  const anfragen = [];
  const server = createServer((req, res) => {
    let roh = '';
    req.on('data', (c) => (roh += c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(roh);
      } catch {
        /* bleibt null */
      }
      const anfrage = { pfad: req.url, headers: req.headers, body };
      anfragen.push(anfrage);
      antwort(anfrage, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    anfragen,
    url: `http://127.0.0.1:${server.address().port}`,
    schliessen: () => new Promise((r) => server.close(r))
  };
}

/** Freier TCP-Port für eine App-Instanz. */
export async function freierPort() {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

export const TEST_KEY = 'sk-ant-testschluessel-nur-fuer-den-mock-0123456789';
