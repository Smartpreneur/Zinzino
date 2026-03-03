module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
};
