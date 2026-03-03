const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body;

  if (!password || password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }

  const token = crypto
    .createHmac('sha256', process.env.APP_PASSWORD)
    .update('zinzino-session')
    .digest('hex');

  res.json({ success: true, token });
};
