const crypto = require('crypto');

function verifyToken(token) {
  if (!token || !process.env.APP_PASSWORD) return false;
  const expected = crypto
    .createHmac('sha256', process.env.APP_PASSWORD)
    .update('zinzino-session')
    .digest('hex');
  return token === expected;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE = 'zinzino_contacts';

async function supaFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || '',
      ...options.headers,
    },
  });
  if (options.prefer === 'return=minimal') return { ok: resp.ok };
  const data = await resp.json();
  return { ok: resp.ok, data };
}

module.exports = async function handler(req, res) {
  // Verify auth token
  const token = req.headers['x-auth-token'] || req.body?.token;
  if (!verifyToken(token)) {
    return res.status(401).json({ error: 'Nicht autorisiert' });
  }

  const { action } = req.body;

  try {
    if (action === 'list') {
      const result = await supaFetch(`${TABLE}?select=*&order=created_at.desc`);
      return res.json(result.data);
    }

    if (action === 'create') {
      const { contact } = req.body;
      const result = await supaFetch(TABLE, {
        method: 'POST',
        body: JSON.stringify(contact),
        prefer: 'return=representation',
      });
      return res.json(result.data);
    }

    if (action === 'update') {
      const { id, fields } = req.body;
      fields.updated_at = new Date().toISOString();
      await supaFetch(`${TABLE}?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
        prefer: 'return=minimal',
      });
      return res.json({ success: true });
    }

    if (action === 'delete') {
      const { id } = req.body;
      await supaFetch(`${TABLE}?id=eq.${id}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
      return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Unbekannte Aktion' });
  } catch (err) {
    console.error('Contacts API error:', err);
    return res.status(500).json({ error: 'Serverfehler' });
  }
};
