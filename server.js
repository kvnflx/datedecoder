const express = require('express');
const path = require('path');
const systemPrompt = require('./prompt');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Nachrichten-Array erforderlich.' });
  }

  const trimmed = messages.slice(-20);
  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...trimmed
  ];

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.5-122b-a10b',
        messages: fullMessages,
        stream: true,
        max_tokens: 4096
      })
    });

    if (!response.ok) {
      if (response.status === 429) {
        return res.status(429).json({ error: 'Zu viele Anfragen — kurz warten und nochmal versuchen.' });
      }
      return res.status(502).json({ error: 'Server gerade nicht erreichbar. Versuch\'s in ein paar Sekunden nochmal.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    req.on('close', () => reader.cancel());

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } finally {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Server gerade nicht erreichbar. Versuch\'s in ein paar Sekunden nochmal.' });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DateDecoder running on port ${PORT}`));
