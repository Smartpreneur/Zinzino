require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Load knowledge base for chat
const WISSEN_DIR = path.join(__dirname, 'Wissen');
const knowledgeFiles = [
  'system_prompt.md',
  'test_interpretation.md',
  'fettsaeuren.md',
  'ernaehrung_und_intervention.md',
  'produkte.md',
  'faq.md'
];
let knowledgeBase = '';
try {
  knowledgeBase = knowledgeFiles
    .map(f => fs.readFileSync(path.join(WISSEN_DIR, f), 'utf-8'))
    .join('\n\n---\n\n');
} catch (err) {
  console.error('Error loading knowledge base:', err.message);
}

function generateToken() {
  return crypto
    .createHmac('sha256', process.env.APP_PASSWORD)
    .update('zinzino-session')
    .digest('hex');
}

function formatTestContext(ctx) {
  let text = '';
  if (ctx.meta) {
    text += '## Personendaten\n';
    text += `- Test-ID: ${ctx.meta.TestID}\n`;
    text += `- Datum: ${ctx.meta.Date}\n`;
    text += `- Alter: ${ctx.meta.Age} Jahre\n`;
    text += `- Geschlecht: ${ctx.meta.Gender === 'female' ? 'Weiblich' : ctx.meta.Gender === 'male' ? 'Männlich' : ctx.meta.Gender}\n`;
    text += `- Land: ${ctx.meta.Country}\n`;
    text += `- Gewicht: ${ctx.meta.weight_exact} kg\n`;
    text += `- Größe: ${ctx.meta.height_exact} cm\n`;
    text += `- Öl-Einnahme: ${ctx.meta.Oil === 'no' ? 'Nein' : ctx.meta.Oil}\n\n`;
  }
  if (ctx.markers) {
    text += '## Marker-Ergebnisse\n';
    for (const m of ctx.markers) {
      text += `- ${m.Fieldname}: ${m.Value} (Ampel: ${m.Color === 'red' ? 'Rot' : m.Color === 'yellow' ? 'Gelb' : 'Grün'})\n`;
    }
    text += '\n';
  }
  if (ctx.fattyAcids) {
    text += '## Fettsäure-Profil\n';
    for (const fa of ctx.fattyAcids) {
      text += `- ${fa.Fieldname} (${fa['Chemical name']}): Ist ${fa.Value}%, Ziel ${fa.Target}%, Abweichung ${fa.Deviation}\n`;
    }
    text += '\n';
  }
  return text;
}

// Proxy endpoint to avoid CORS issues
app.post('/api/check-test', async (req, res) => {
  const { testId } = req.body;

  if (!testId || testId.trim().length === 0) {
    return res.status(400).json({ error: 'Test-ID ist erforderlich' });
  }

  const sanitizedId = testId.trim().replace(/[^a-zA-Z0-9]/g, '');

  // Determine which endpoint to use based on test ID suffix
  let endpoint = 'ajax.check_results.php'; // Default: BalanceTest
  const upper = sanitizedId.toUpperCase();
  if (upper.endsWith('GH')) {
    endpoint = 'ajax.check_results_simple_guthealth.php';
  } else if (upper.endsWith('VD')) {
    endpoint = 'ajax.check_results_vitamind.php';
  } else if (upper.endsWith('HC')) {
    endpoint = 'ajax.check_results_simple_hba1c.php';
  }

  try {
    const response = await fetch(
      `https://www.zinzinotest.com/modules/Menu/output/${endpoint}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `val=${encodeURIComponent(sanitizedId)}&type=1`,
      }
    );

    if (!response.ok) {
      return res.status(502).json({ error: 'Zinzino-Server nicht erreichbar' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'Fehler beim Abrufen der Testergebnisse' });
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  const { password } = req.body;

  if (!password || password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }

  res.json({ success: true, token: generateToken() });
});

// Chat endpoint with Claude streaming
app.post('/api/chat', async (req, res) => {
  const { token, messages, testContext } = req.body;

  if (!token || token !== generateToken()) {
    return res.status(401).json({ error: 'Nicht autorisiert' });
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Keine Nachrichten übergeben' });
  }

  const trimmedMessages = messages.slice(-20);

  let systemPrompt = knowledgeBase;
  if (testContext) {
    systemPrompt += '\n\n---\n\n# Aktuelle Testergebnisse des Kunden\n\n';
    systemPrompt += 'Die folgenden Testergebnisse wurden geladen. Nutze sie für personalisierte Beratung, Gesprächsleitfäden und Empfehlungen.\n\n';
    systemPrompt += formatTestContext(testContext);
  }

  try {
    const client = new Anthropic();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: trimmedMessages
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });

    stream.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });

    stream.on('error', (err) => {
      console.error('Claude stream error:', err);
      let errorMsg = 'KI-Fehler aufgetreten';
      if (err.status === 400 && err.message && err.message.includes('credit balance')) {
        errorMsg = 'API-Guthaben aufgebraucht. Bitte Credits auf console.anthropic.com aufladen.';
      } else if (err.status === 401) {
        errorMsg = 'Ungültiger API-Schlüssel. Bitte ANTHROPIC_API_KEY prüfen.';
      } else if (err.status === 429) {
        errorMsg = 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.';
      } else if (err.status === 529) {
        errorMsg = 'Anthropic API ist überlastet. Bitte in einer Minute erneut versuchen.';
      } else if (err.message) {
        errorMsg = `KI-Fehler: ${err.message}`;
      }
      res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  } catch (err) {
    console.error('Chat API error:', err);
    let errorMsg = 'Fehler bei der KI-Anfrage';
    if (err.status === 400 && err.message && err.message.includes('credit balance')) {
      errorMsg = 'API-Guthaben aufgebraucht. Bitte Credits auf console.anthropic.com aufladen.';
    } else if (err.status === 401) {
      errorMsg = 'Ungültiger API-Schlüssel. Bitte ANTHROPIC_API_KEY prüfen.';
    } else if (err.message) {
      errorMsg = `KI-Fehler: ${err.message}`;
    }
    res.status(500).json({ error: errorMsg });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
