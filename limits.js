// Kostenbremse für die öffentliche Seite. Seit dem Umstieg auf Claude (2026-11-25)
// kostet jede Anfrage echtes Geld, und die Seite ist ohne Login erreichbar. Zwei
// Schranken greifen deshalb zusammen:
//   1. TagesLimit:  wenige Anfragen pro IP und Tag, verteilt das Budget auf mehr Leute.
//   2. TagesBudget: harte Obergrenze in USD über alle Nutzer, abgerechnet nach den
//      tatsächlich verbrauchten Tokens. Fängt auch ab, was am IP-Limit vorbeikommt
//      (gefälschte Proxy-Header, viele IPs).
// Beides lebt im Speicher und beginnt nach einem Neustart von vorn. Das ist bewusst
// so: Die eigentliche Notbremse ist das Ausgabenlimit in der Anthropic-Console.

/** USD pro 1 Mio. Tokens (Stand 2026-11). Haiku 5.5 kostet über 100K Prompt-Tokens mehr. */
const PREISE = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  // Ziele des serverseitigen Refusal-Fallbacks ("fallbacks": "default")
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 }
};
const HAIKU_LANGER_PROMPT = { input: 0.5, output: 2.5 };
// Unbekanntes Modell: lieber zu teuer rechnen als das Budget unbemerkt zu überziehen.
const TEUERSTER = { input: 5, output: 25 };

/** Kosten einer Anfrage in USD aus dem usage-Objekt der Anthropic-API. */
function kostenUsd(model, usage = {}) {
  const input = usage.input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;

  let p = PREISE[model] || TEUERSTER;
  if (model === 'claude-haiku-5-5' && input + cacheWrite + cacheRead > 100000) p = HAIKU_LANGER_PROMPT;

  return (input * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.input * 0.1 + output * p.output) / 1e6;
}

/** Kalendertag in UTC, z. B. "2026-11-25". Beide Schranken springen um Mitternacht UTC zurück. */
function tagVon(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Sekunden bis zum nächsten Tageswechsel, für den Retry-After-Header. */
function sekundenBisMorgen(ms) {
  const morgen = new Date(ms);
  morgen.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((morgen.getTime() - ms) / 1000));
}

/** Höchstens `max` Anfragen pro Schlüssel (IP) und Kalendertag. */
class TagesLimit {
  constructor({ max, jetzt = Date.now }) {
    this.max = max;
    this.jetzt = jetzt;
    this.tag = tagVon(jetzt());
    this.zaehler = new Map();
  }

  #rollen() {
    const heute = tagVon(this.jetzt());
    if (heute !== this.tag) {
      this.tag = heute;
      this.zaehler.clear();
    }
  }

  /** Bucht eine Anfrage. false, wenn das Kontingent für heute erschöpft ist. */
  nehmen(schluessel) {
    this.#rollen();
    const n = this.zaehler.get(schluessel) || 0;
    if (n >= this.max) return false;
    this.zaehler.set(schluessel, n + 1);
    return true;
  }

  /** Gibt eine Anfrage zurück, die dem Nutzer nichts geliefert hat (Upstream-Fehler). */
  zurueckgeben(schluessel) {
    this.#rollen();
    const n = this.zaehler.get(schluessel) || 0;
    if (n <= 1) this.zaehler.delete(schluessel);
    else this.zaehler.set(schluessel, n - 1);
  }
}

/**
 * Tagesbudget in USD. Vor jeder Anfrage wird eine Schätzung reserviert, danach mit
 * den echten Kosten abgerechnet. Ohne Reservierung könnten mehrere gleichzeitige
 * Anfragen das Budget gemeinsam überziehen, weil die Kosten erst am Ende feststehen.
 */
class TagesBudget {
  constructor({ limitUsd, jetzt = Date.now }) {
    this.limitUsd = limitUsd;
    this.jetzt = jetzt;
    this.tag = tagVon(jetzt());
    this.ausgegeben = 0;
    this.reserviert = 0;
  }

  #rollen() {
    const heute = tagVon(this.jetzt());
    if (heute !== this.tag) {
      this.tag = heute;
      this.ausgegeben = 0; // offene Reservierungen laufen weiter und werden heute abgerechnet
    }
  }

  /** Reserviert `betragUsd`. null, wenn das Budget dafür nicht mehr reicht. */
  reservieren(betragUsd) {
    this.#rollen();
    if (this.ausgegeben + this.reserviert + betragUsd > this.limitUsd) return null;
    this.reserviert += betragUsd;
    return { betrag: betragUsd, offen: true };
  }

  /** Ersetzt die Reservierung durch die tatsächlichen Kosten. Mehrfachaufrufe sind wirkungslos. */
  abrechnen(reservierung, tatsaechlichUsd) {
    if (!reservierung || !reservierung.offen) return;
    reservierung.offen = false;
    this.#rollen();
    this.reserviert = Math.max(0, this.reserviert - reservierung.betrag);
    this.ausgegeben += Math.max(0, tatsaechlichUsd);
  }

  stand() {
    this.#rollen();
    return { tag: this.tag, ausgegeben: this.ausgegeben, reserviert: this.reserviert, limit: this.limitUsd };
  }
}

module.exports = { PREISE, kostenUsd, sekundenBisMorgen, TagesLimit, TagesBudget };
