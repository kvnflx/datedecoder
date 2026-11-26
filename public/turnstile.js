// Turnstile: Cloudflares Prüfung, ob ein Mensch die Analyse startet. Meist
// unsichtbar, das Feld erscheint nur, wenn Cloudflare nachfragen will. Ist auf dem
// Server kein Site-Key gesetzt, bleibt alles aus und token() liefert null.
// Jede Analyse braucht ein frisches Token, der Server lehnt wiederverwendete ab.
const turnstileSchutz = (() => {
  let siteKey = null;
  let widgetId = null;
  let offen = null; // { resolve, reject } der laufenden Prüfung

  function beende(fehler, token) {
    if (!offen) return;
    const o = offen;
    offen = null;
    if (fehler) o.reject(new Error(fehler));
    else o.resolve(token);
  }

  function ladeSkript() {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Die Sicherheitsprüfung konnte nicht geladen werden. Lade die Seite neu.'));
      document.head.appendChild(s);
    });
  }

  const bereit = (async () => {
    const r = await fetch('/api/config', { cache: 'no-store' });
    siteKey = (await r.json()).turnstileSiteKey || null;
    if (!siteKey) return;
    await ladeSkript();
    widgetId = window.turnstile.render('#turnstile', {
      sitekey: siteKey,
      action: 'analyse',
      execution: 'execute',
      appearance: 'interaction-only',
      language: 'de',
      callback: (token) => beende(null, token),
      'error-callback': () => {
        beende('Die Sicherheitsprüfung ist fehlgeschlagen. Lade die Seite neu und versuch es nochmal.');
        return true;
      },
      'expired-callback': () => window.turnstile.reset(widgetId),
      'timeout-callback': () => beende('Die Sicherheitsprüfung ist abgelaufen. Versuch es nochmal.')
    });
  })();

  /** Frisches Token für genau eine Anfrage, oder null ohne Turnstile. */
  async function token() {
    await bereit;
    if (!siteKey) return null;
    beende('Abgebrochen.'); // eine evtl. hängende alte Prüfung verwerfen
    const diese = {};
    const ergebnis = new Promise((resolve, reject) => {
      diese.resolve = resolve;
      diese.reject = reject;
    });
    offen = diese;
    window.turnstile.reset(widgetId);
    window.turnstile.execute(widgetId);
    // Nur diese Prüfung abbrechen, nie eine spätere.
    setTimeout(() => {
      if (offen === diese) beende('Die Sicherheitsprüfung dauert zu lange. Versuch es nochmal.');
    }, 90000);
    return ergebnis;
  }

  bereit.catch(() => {}); // Fehler kommen erst beim nächsten token() an den Nutzer

  return { token };
})();
