const Anthropic = require('@anthropic-ai/sdk');
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
    const client = new Anthropic();

    // Stream response using SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
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
      res.write(`data: ${JSON.stringify({ error: 'KI-Fehler aufgetreten' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

  } catch (err) {
    console.error('Chat API error:', err);
    res.status(500).json({ error: 'Fehler bei der KI-Anfrage' });
  }
};
