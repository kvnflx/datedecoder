const state = {
  messages: [],
  isStreaming: false
};

const $ = (sel) => document.querySelector(sel);

document.addEventListener('DOMContentLoaded', () => {
  $('#input-text').addEventListener('input', updateAnalyzeBtn);
  $('#btn-analyze').addEventListener('click', startAnalysis);
  $('#btn-screenshot').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', handleFileSelect);
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
  updateAnalyzeBtn();
  switchMode('input');
}

// ── Screenshot OCR ──

async function handleFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const textarea = $('#input-text');
  const btn = $('#btn-screenshot');
  const original = btn.textContent;
  btn.textContent = '⏳ Wird erkannt...';
  btn.disabled = true;

  try {
    const { data: { text } } = await Tesseract.recognize(file, 'deu+eng');
    textarea.value = text.trim();
    updateAnalyzeBtn();
  } catch (err) {
    textarea.value = '';
    textarea.placeholder = 'Text konnte nicht erkannt werden. Versuch’s mit einem klareren Screenshot oder tippe den Text ab.';
  } finally {
    btn.textContent = original;
    btn.disabled = false;
    e.target.value = '';
  }
}

// ── Textdatei-Upload ──

async function handleTextFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const textarea = $('#input-text');
  const btn = $('#btn-textfile');
  const original = btn.textContent;
  btn.textContent = '⏳ Wird gelesen...';
  btn.disabled = true;

  try {
    const text = await file.text();
    textarea.value = text.trim();
    updateAnalyzeBtn();
  } catch (err) {
    textarea.placeholder = 'Datei konnte nicht gelesen werden. Versuch eine andere Datei oder paste den Text direkt.';
  } finally {
    btn.textContent = original;
    btn.disabled = false;
    e.target.value = '';
  }
}
