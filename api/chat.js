const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load knowledge base files once at cold start
const WISSEN_DIR = path.join(__dirname, '..', 'Wissen');
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
    text += '| Fettsäure | Chem. Name | Ist-Wert | Zielwert | Abweichung |\n';
    text += '|-----------|-----------|----------|----------|------------|\n';
    for (const fa of ctx.fattyAcids) {
      text += `| ${fa.Fieldname} | ${fa['Chemical name']} | ${fa.Value}% | ${fa.Target}% | ${fa.Deviation} |\n`;
    }
    text += '\n';
  }
  return text;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, messages, testContext } = req.body;

  // Verify token
  const expectedToken = crypto
    .createHmac('sha256', process.env.APP_PASSWORD)
    .update('zinzino-session')
    .digest('hex');

  if (!token || token !== expectedToken) {
    return res.status(401).json({ error: 'Nicht autorisiert' });
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Keine Nachrichten übergeben' });
  }

  // Trim conversation history to last 20 messages to control costs
  const trimmedMessages = messages.slice(-20);

  // Build system prompt
  let systemPrompt = knowledgeBase;

  if (testContext) {
    systemPrompt += '\n\n---\n\n# Aktuelle Testergebnisse des Kunden\n\n';
    systemPrompt += 'Die folgenden Testergebnisse wurden geladen. Nutze sie für personalisierte Beratung, Gesprächsleitfäden und Empfehlungen.\n\n';
    systemPrompt += formatTestContext(testContext);
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.1-flash-lite-preview',
      systemInstruction: systemPrompt
    });

    // Convert messages to Gemini format
    const history = trimmedMessages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const lastMessage = trimmedMessages[trimmedMessages.length - 1].content;

    const chat = model.startChat({ history });

    // Stream response using SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const result = await chat.sendMessageStream(lastMessage);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    console.error('Chat API error:', err);
    let errorMsg = 'KI-Fehler aufgetreten';
    if (err.message && err.message.includes('API_KEY_INVALID')) {
      errorMsg = 'Ungültiger API-Schlüssel. Bitte GOOGLE_API_KEY prüfen.';
    } else if (err.message && err.message.includes('RESOURCE_EXHAUSTED')) {
      errorMsg = 'API-Kontingent erschöpft. Bitte später erneut versuchen.';
    } else if (err.message && err.message.includes('PERMISSION_DENIED')) {
      errorMsg = 'API-Zugriff verweigert. Bitte Gemini API in der Google Cloud Console aktivieren.';
    } else if (err.message) {
      errorMsg = `KI-Fehler: ${err.message}`;
    }

    // If headers not sent yet, send JSON error
    if (!res.headersSent) {
      res.status(500).json({ error: errorMsg });
    } else {
      res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
};
