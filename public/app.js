const state = {
  messages: [],
  isStreaming: false,
  shots: [] // gestapelte Screenshots vor der Texterkennung, in Anzeige-Reihenfolge
};

const $ = (sel) => document.querySelector(sel);

document.addEventListener('DOMContentLoaded', () => {
  $('#input-text').addEventListener('input', updateAnalyzeBtn);
  $('#btn-analyze').addEventListener('click', startAnalysis);
  $('#btn-screenshot').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', handleFileSelect);
  $('#btn-shots-run').addEventListener('click', runShots);
  $('#btn-shots-clear').addEventListener('click', clearShots);
  $('#shots-list').addEventListener('click', onShotAction);
  $('#btn-seite-rechts').addEventListener('click', () => setSeite('rechts'));
  $('#btn-seite-links').addEventListener('click', () => setSeite('links'));
  $('#btn-textfile').addEventListener('click', () => $('#textfile-input').click());
  $('#textfile-input').addEventListener('change', handleTextFileSelect);
  $('#btn-send').addEventListener('click', sendFollowUp);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) sendFollowUp();
  });
  $('#btn-new').addEventListener('click', resetToInput);
});

function updateAnalyzeBtn() {
  $('#btn-analyze').disabled = !$('#input-text').value.trim();
}

// ── Analysis Flow ──

async function startAnalysis() {
  const text = $('#input-text').value.trim();
  if (!text || state.isStreaming) return;

  state.messages = [{ role: 'user', content: text }];
  switchMode('chat');
  addUserMessage(text);

  const contentEl = addAssistantMessage();

  try {
    const content = await streamResponse(state.messages, contentEl);
    state.messages.push({ role: 'assistant', content });
    makeCollapsible(contentEl);
  } catch (err) {
    contentEl.textContent = err.message;
    contentEl.classList.add('error');
  }
}

async function sendFollowUp() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || state.isStreaming) return;

  input.value = '';
  state.messages.push({ role: 'user', content: text });
  addUserMessage(text);

  const contentEl = addAssistantMessage();

  try {
    const content = await streamResponse(state.messages, contentEl);
    state.messages.push({ role: 'assistant', content });
  } catch (err) {
    contentEl.textContent = err.message;
    contentEl.classList.add('error');
  }
}

// ── SSE Streaming ──

async function streamResponse(messages, targetEl) {
  state.isStreaming = true;
  setInputsDisabled(true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    });

    if (!response.ok) {
      // Body genau einmal als Text lesen und optimistisch parsen. Ein reines
      // response.json() scheitert, sobald ein Proxy (Cloudflare, Traefik) eine
      // eigene text/plain-Fehlerseite liefert — dann blieb früher nur der
      // nichtssagende Text "Unbekannter Fehler" übrig.
      const raw = await response.text().catch(() => '');
      let msg = '';
      try {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object' && typeof d.error === 'string') msg = d.error;
      } catch (e) {
        // kein JSON — dann greift die statusbezogene Meldung unten
      }
      if (!msg) {
        const byStatus = {
          413: 'Der Chatverlauf ist zu groß. Kürze ihn oder teile ihn auf.',
          429: 'Zu viele Anfragen — kurz warten und nochmal versuchen.',
          502: 'Der Analyse-Server ist gerade nicht erreichbar (502). Versuch es in ein paar Sekunden nochmal.',
          503: 'Der Analyse-Server ist gerade nicht erreichbar (503). Versuch es in ein paar Sekunden nochmal.',
          504: 'Zeitüberschreitung beim Analyse-Server (504).',
          524: 'Die Analyse hat zu lange gedauert (524). Versuch es mit einem kürzeren Chatverlauf.'
        };
        msg = byStatus[response.status] || `Unerwarteter Fehler (HTTP ${response.status}).`;
      }
      throw new Error(msg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          targetEl.innerHTML = formatText(fullContent);
          return fullContent;
        }
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          continue; // unlesbare SSE-Zeile überspringen
        }

        // Fehler, die erst mitten im Stream auftreten, dürfen nicht stillschweigend
        // verschluckt werden — sonst bricht die Analyse kommentarlos ab.
        if (parsed.error) {
          throw new Error(parsed.error.message || 'Fehler während der Analyse.');
        }

        // Der Server meldet hier z. B., dass ein sehr langer Verlauf gekürzt wurde.
        // Das gehört sichtbar über die Analyse — sonst zieht man Schlüsse aus einer
        // unvollständigen Grundlage, ohne es zu merken.
        if (parsed.hinweis) {
          showHinweis(targetEl, parsed.hinweis);
          continue;
        }

        const delta = parsed.choices?.[0]?.delta || {};
        // reasoning_content bewusst NICHT anhängen: bei Reasoning-Modellen landete
        // sonst die rohe Denkkette im Analysekasten und überdeckte die 4 Schichten.
        const token = delta.content || '';
        if (!token) continue;
        fullContent += token;
        targetEl.innerHTML = formatText(fullContent) + '<span class="cursor">▌</span>';
        scrollToBottom();
      }
    }

    targetEl.innerHTML = formatText(fullContent);
    return fullContent;
  } finally {
    state.isStreaming = false;
    setInputsDisabled(false);
  }
}

// ── UI Helpers ──

function switchMode(mode) {
  $('#app').className = 'mode-' + mode;
}

function addUserMessage(text) {
  const div = document.createElement('div');
  div.className = 'message user-message';
  div.textContent = text;
  $('#messages').appendChild(div);
  scrollToBottom(true);
  return div;
}

function addAssistantMessage() {
  const wrapper = document.createElement('div');
  wrapper.className = 'message assistant-message';

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = 'ANALYSE';

  const content = document.createElement('div');
  content.className = 'message-content';

  wrapper.appendChild(label);
  wrapper.appendChild(content);
  $('#messages').appendChild(wrapper);
  scrollToBottom(true);
  return content;
}

function showHinweis(contentEl, text) {
  const wrapper = contentEl.parentElement;
  if (!wrapper || wrapper.querySelector('.analyse-hinweis')) return;
  const box = document.createElement('div');
  box.className = 'analyse-hinweis';
  box.textContent = 'ℹ️ ' + text;
  wrapper.insertBefore(box, contentEl);
}

function makeCollapsible(contentEl) {
  const wrapper = contentEl.parentElement;
  const toggle = document.createElement('div');
  toggle.className = 'collapse-toggle';
  toggle.textContent = 'Analyse einklappen ▲';
  toggle.addEventListener('click', () => {
    wrapper.classList.toggle('collapsed');
    toggle.textContent = wrapper.classList.contains('collapsed')
      ? 'Analyse anzeigen ▼'
      : 'Analyse einklappen ▲';
  });
  wrapper.insertBefore(toggle, contentEl);
}

function formatText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}

function isNearBottom() {
  const el = $('#messages');
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distanceFromBottom < 80;
}

function scrollToBottom(force = false) {
  const el = $('#messages');
  if (force || isNearBottom()) {
    el.scrollTop = el.scrollHeight;
  }
}

function setInputsDisabled(disabled) {
  $('#btn-send').disabled = disabled;
  $('#chat-input').disabled = disabled;
  $('#btn-analyze').disabled = disabled;
}

function resetToInput() {
  state.messages = [];
  $('#messages').innerHTML = '';
  $('#input-text').value = '';
  state.shots = [];
  renderShots();
  setShotsMsg('');
  setProgress('');
  updateAnalyzeBtn();
  switchMode('input');
}

// ── Screenshot OCR (Mehrfach-Upload, Reihenfolge, Seiten-Zuordnung) ──

let shotSeq = 0;              // laufende ID je Screenshot
let shotsBusy = false;        // true, solange die Texterkennung läuft
let meineSeite = 'rechts';    // wo die eigenen Nachrichten stehen: 'rechts' | 'links'

function setSeite(seite) {
  if (shotsBusy) return;
  meineSeite = seite === 'links' ? 'links' : 'rechts';
  $('#btn-seite-rechts').classList.toggle('aktiv', meineSeite === 'rechts');
  $('#btn-seite-links').classList.toggle('aktiv', meineSeite === 'links');
}

function handleFileSelect(e) {
  const gewaehlt = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
  e.target.value = ''; // erlaubt, dieselbe Datei erneut auszuwählen
  if (state.isStreaming || shotsBusy || !gewaehlt.length) return;

  for (const file of gewaehlt) {
    // Dieselbe Datei nicht doppelt aufnehmen, falls der Dialog erneut geöffnet wird.
    const schonDa = state.shots.some(
      (s) =>
        s.file.name === file.name &&
        s.file.size === file.size &&
        s.file.lastModified === file.lastModified
    );
    if (!schonDa) state.shots.push({ id: ++shotSeq, file });
  }

  sortShots();
  renderShots();
  setShotsMsg('');
}

// Automatische Reihenfolge: nach Aufnahmezeit (lastModified, millisekundengenau),
// bei Gleichstand nach Dateiname in natürlicher, numerischer Sortierung. Läuft nur
// beim Hinzufügen — eine manuelle Korrektur per ▲▼ bleibt danach erhalten, bis
// erneut Dateien hinzugefügt werden.
function sortShots() {
  state.shots.sort((a, b) => {
    const d = (a.file.lastModified || 0) - (b.file.lastModified || 0);
    if (d !== 0) return d;
    return a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function renderShots() {
  const tray = $('#shots-tray');
  const list = $('#shots-list');
  list.innerHTML = '';

  if (state.shots.length === 0) {
    tray.hidden = true;
    return;
  }
  tray.hidden = false;

  state.shots.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'shot-row';
    li.dataset.id = String(s.id);

    const idx = document.createElement('span');
    idx.className = 'shot-idx';
    idx.textContent = String(i + 1);

    const name = document.createElement('span');
    name.className = 'shot-name';
    name.textContent = s.file.name;
    name.title = s.file.name;

    const time = document.createElement('span');
    time.className = 'shot-time';
    time.textContent = fmtTime(s.file.lastModified);

    const up = mkShotBtn('shot-up', '▲', 'nach oben', i === 0);
    const down = mkShotBtn('shot-down', '▼', 'nach unten', i === state.shots.length - 1);
    const del = mkShotBtn('shot-del', '×', 'entfernen', false);

    li.append(idx, name, time, up, down, del);
    list.appendChild(li);
  });

  $('#btn-shots-run').textContent = `Text erkennen (${state.shots.length})`;
}

function mkShotBtn(cls, label, aria, disabled) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'shot-btn ' + cls;
  b.textContent = label;
  b.setAttribute('aria-label', aria);
  b.disabled = disabled;
  return b;
}

// Reihenfolge ändern oder Bild entfernen — per Delegation auf der Liste.
function onShotAction(e) {
  if (shotsBusy) return;
  const btn = e.target.closest('button');
  if (!btn) return;
  const row = btn.closest('.shot-row');
  if (!row) return;
  const id = row.dataset.id;
  const i = state.shots.findIndex((s) => s.id === Number(id));
  if (i === -1) return;

  let aktion = null;
  if (btn.classList.contains('shot-up') && i > 0) {
    [state.shots[i - 1], state.shots[i]] = [state.shots[i], state.shots[i - 1]];
    aktion = 'shot-up';
  } else if (btn.classList.contains('shot-down') && i < state.shots.length - 1) {
    [state.shots[i + 1], state.shots[i]] = [state.shots[i], state.shots[i + 1]];
    aktion = 'shot-down';
  } else if (btn.classList.contains('shot-del')) {
    state.shots.splice(i, 1);
    aktion = 'shot-del';
  } else {
    return;
  }
  renderShots();
  stelleFokusWiederHer(id, aktion);
}

// Nach dem Neuaufbau der Liste den Fokus sinnvoll zurücksetzen, damit Tastatur- und
// Screenreader-Bedienung nicht bei jedem Schritt nach oben springt.
function stelleFokusWiederHer(id, aktion) {
  const list = $('#shots-list');
  if (aktion === 'shot-del') {
    const ziel = list.querySelector('.shot-btn:not(:disabled)') || $('#btn-shots-run');
    if (ziel && !ziel.disabled) ziel.focus();
    return;
  }
  const row = list.querySelector('.shot-row[data-id="' + id + '"]');
  if (!row) return;
  let ziel = row.querySelector('.' + aktion);
  if (!ziel || ziel.disabled) ziel = row.querySelector('.shot-btn:not(:disabled)');
  if (ziel) ziel.focus();
}

function clearShots() {
  if (shotsBusy) return;
  state.shots = [];
  renderShots();
  setShotsMsg('');
  setProgress('');
}

// Erkennt alle Screenshots der Reihe nach, ordnet jede Zeile ihrer Seite zu und hängt
// den beschrifteten Verlauf ans Textfeld an. Ein einzelnes Bild ohne Text bricht den
// Stapel nicht ab; fehlgeschlagene Bilder bleiben zum erneuten Versuch stehen.
async function runShots() {
  if (shotsBusy || state.isStreaming || state.shots.length === 0) return;

  if (typeof Tesseract === 'undefined') {
    setShotsMsg('⚠ Texterkennung konnte nicht geladen werden — Internetverbindung oder Adblocker prüfen und Seite neu laden.');
    return;
  }

  shotsBusy = true;
  const runBtn = $('#btn-shots-run');
  const clearBtn = $('#btn-shots-clear');
  runBtn.disabled = true;
  clearBtn.disabled = true;
  setSecondaryDisabled(true);
  $('#shots-tray').classList.add('shots-busy');
  setShotsMsg('');

  const stapel = state.shots.slice(); // Reihenfolge einfrieren, UI ist gesperrt
  const total = stapel.length;

  let worker = null;
  try {
    runBtn.textContent = 'Wird geladen…';
    setProgress('Texterkennung wird geladen');
    worker = await Tesseract.createWorker('deu+eng');
  } catch (err) {
    // Engine gar nicht verfügbar: Stapel behalten, nichts löschen, klar melden.
    setProgress('');
    setShotsMsg('⚠ Texterkennung konnte nicht geladen werden — Internetverbindung oder Adblocker prüfen und erneut versuchen.');
    runBtn.textContent = `Text erkennen (${total})`;
    beendeLauf();
    return;
  }

  const verlaeufe = [];
  const gelungen = new Set();  // ids erfolgreich verarbeiteter Bilder
  const fehlgeschlagen = [];   // Dateinamen ohne erkannten Text
  const helligkeiten = [];     // { seite, lum } über alle Bilder, für den Farb-Check

  for (let i = 0; i < total; i++) {
    const s = stapel[i];
    runBtn.textContent = `Bild ${i + 1}/${total}…`;
    setProgress(`Bild ${i + 1} von ${total} wird erkannt`);
    try {
      const ergebnis = await verarbeiteBild(s.file, worker);
      if (ergebnis && ergebnis.verlauf.trim()) {
        verlaeufe.push(ergebnis.verlauf.trim());
        for (const h of ergebnis.helligkeiten) helligkeiten.push(h);
        gelungen.add(s.id);
      } else {
        fehlgeschlagen.push(s.file.name);
      }
    } catch (err) {
      fehlgeschlagen.push(s.file.name);
    }
  }

  try { await worker.terminate(); } catch (e) { /* Aufräumen, egal ob es klappt */ }

  // Anhängen statt ersetzen: getippten Kontext oder frühere Erkennung bewahren.
  if (verlaeufe.length) {
    const feld = $('#input-text');
    const vorhandener = feld.value.trim();
    const neuerText = verlaeufe.join('\n\n');
    feld.value = vorhandener ? vorhandener + '\n\n' + neuerText : neuerText;
  }

  // Nur erfolgreiche Bilder aus dem Stapel nehmen; fehlgeschlagene bleiben stehen.
  state.shots = state.shots.filter((s) => !gelungen.has(s.id));
  renderShots();

  const hinweise = [];
  if (fehlgeschlagen.length) {
    hinweise.push(`kein Text erkannt: ${fehlgeschlagen.join(', ')} — bleiben zum erneuten Versuch stehen`);
  }
  const farbHinweis = pruefeFarbKonsistenz(helligkeiten);
  if (farbHinweis) hinweise.push(farbHinweis);
  setShotsMsg(hinweise.length ? '⚠ ' + hinweise.join(' · ') : '');
  setProgress(
    verlaeufe.length
      ? `${verlaeufe.length} von ${total} Screenshots erkannt und zugeordnet`
      : 'Kein Text erkannt'
  );

  beendeLauf();
  updateAnalyzeBtn();
}

// Hebt die UI-Sperre nach einem OCR-Lauf wieder auf.
function beendeLauf() {
  shotsBusy = false;
  $('#btn-shots-run').disabled = false;
  $('#btn-shots-clear').disabled = false;
  setSecondaryDisabled(false);
  $('#shots-tray').classList.remove('shots-busy');
}

// Erkennt ein Bild und liefert den beschrifteten Verlauf plus die Helligkeiten je Zeile.
async function verarbeiteBild(file, worker) {
  const { data } = await worker.recognize(file, {}, { blocks: true });

  const zeilen = [];
  for (const block of data.blocks || []) {
    for (const line of block.lines || []) {
      const t = (line.text || '').trim();
      if (t && line.bbox) zeilen.push({ text: t, x0: line.bbox.x0, x1: line.bbox.x1, bbox: line.bbox });
    }
  }
  if (!zeilen.length) return { verlauf: '', helligkeiten: [] };

  // Bildbreite und Pixel für Position und Farb-Absicherung aus einem Canvas.
  try {
    const bitmap = await createImageBitmap(file);
    const breite = bitmap.width;
    const hoehe = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = breite;
    canvas.height = hoehe;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, breite, hoehe).data;
    if (bitmap.close) bitmap.close();

    const klass = klassifiziereZeilen(zeilen, breite, meineSeite);
    const helligkeiten = [];
    for (let k = 0; k < zeilen.length; k++) {
      if (klass[k].seite === 'kontext') continue;
      const lum = mittlereHelligkeit(px, zeilen[k].bbox, breite, hoehe);
      if (lum !== null) helligkeiten.push({ seite: klass[k].seite, lum });
    }
    return { verlauf: baueVerlauf(klass), helligkeiten };
  } catch (e) {
    // Canvas/Bitmap nicht verfügbar: nur Position, Breite aus der größten rechten Kante nähern.
    const breite = zeilen.reduce((m, z) => Math.max(m, z.x1), 0) || 1;
    return { verlauf: baueVerlauf(klassifiziereZeilen(zeilen, breite, meineSeite)), helligkeiten: [] };
  }
}

// Mittlere Helligkeit (0–255) über ein Raster innerhalb der Zeilen-Box.
function mittlereHelligkeit(px, bbox, breite, hoehe) {
  const x0 = Math.max(0, Math.floor(bbox.x0));
  const x1 = Math.min(breite - 1, Math.ceil(bbox.x1));
  const y0 = Math.max(0, Math.floor(bbox.y0));
  const y1 = Math.min(hoehe - 1, Math.ceil(bbox.y1));
  if (x1 <= x0 || y1 <= y0) return null;

  const nx = Math.max(1, Math.min(24, x1 - x0));
  const ny = Math.max(1, Math.min(6, y1 - y0));
  let summe = 0;
  let n = 0;
  for (let iy = 0; iy <= ny; iy++) {
    const y = y0 + Math.round((iy / ny) * (y1 - y0));
    for (let ix = 0; ix <= nx; ix++) {
      const x = x0 + Math.round((ix / nx) * (x1 - x0));
      const off = (y * breite + x) * 4;
      summe += 0.2126 * px[off] + 0.7152 * px[off + 1] + 0.0722 * px[off + 2];
      n++;
    }
  }
  return n ? summe / n : null;
}

// Beratender Farb-Check: sind die zwei Seiten farblich klar getrennt, bestätigt das die
// Positionszuordnung. Wirken sie ununterscheidbar, ein sanfter Hinweis zum Prüfen.
function pruefeFarbKonsistenz(helligkeiten) {
  const ich = helligkeiten.filter((h) => h.seite === 'ich').map((h) => h.lum);
  const geg = helligkeiten.filter((h) => h.seite === 'gegenueber').map((h) => h.lum);
  if (ich.length < 2 || geg.length < 2) return '';
  const mittel = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const abstand = Math.abs(mittel(ich) - mittel(geg));
  if (abstand < 20) {
    return 'die beiden Seiten sind farblich kaum zu unterscheiden — den beschrifteten Verlauf bitte kurz gegenlesen';
  }
  return '';
}

function setSecondaryDisabled(disabled) {
  $('#btn-screenshot').disabled = disabled;
  $('#btn-textfile').disabled = disabled;
  $('#btn-analyze').disabled = disabled;
}

function setShotsMsg(text) {
  const el = $('#shots-msg');
  el.textContent = text || '';
  el.hidden = !text;
}

function setProgress(text) {
  const el = $('#shots-progress');
  if (el) el.textContent = text || '';
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── Textdatei-Upload ──

async function handleTextFileSelect(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (shotsBusy || state.isStreaming) return; // schließt sich mit der OCR aus

  const textarea = $('#input-text');
  const btn = $('#btn-textfile');
  const original = btn.textContent;
  btn.textContent = '⏳ Wird gelesen...';
  btn.disabled = true;

  try {
    const text = await file.text();
    const vorhandener = textarea.value.trim();
    const neuer = text.trim();
    textarea.value = vorhandener ? vorhandener + '\n\n' + neuer : neuer;
    updateAnalyzeBtn();
  } catch (err) {
    textarea.placeholder = 'Datei konnte nicht gelesen werden. Versuch eine andere Datei oder paste den Text direkt.';
  } finally {
    btn.textContent = original;
    btn.disabled = shotsBusy; // während laufender OCR gesperrt lassen
  }
}
