export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { category, risk, horizon, goal } = req.body || {};
  if (!category || !risk || !horizon || !goal) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is not set. Please add it in Vercel → Settings → Environment Variables.' });
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  const prompt = `You are a knowledgeable investment analyst. Today is ${today}.

User investor profile:
- Category interest: ${category}
- Risk tolerance: ${risk}
- Time horizon: ${horizon}
- Primary goal: ${goal}

Return ONLY valid JSON — no markdown, no backticks, no extra text whatsoever. Use exactly this structure:
{
  "market_context": "1-2 sentences about current market conditions for this fund category and why it matters to this specific investor right now",
  "funds": [
    {
      "name": "Full Official Fund Name",
      "ticker": "TICK",
      "type": "ETF or Mutual Fund",
      "issuer": "Vanguard / Fidelity / iShares / Schwab / etc",
      "expense_ratio": "0.03%",
      "category_tag": "e.g. Large-Cap Blend",
      "why_fits": "2-3 sentences in plain English explaining why THIS fund specifically fits the user's risk level, time horizon, and goal. Be concrete, directly reference their inputs.",
      "key_metric_label": "e.g. 10-Year Avg Return",
      "key_metric_value": "e.g. ~11.2% per year",
      "fit_score": 95,
      "best_for": "short phrase e.g. set-and-forget long-term investors",
      "watch_out": "One sentence on the main risk or drawback"
    }
  ]
}

Exactly 4 funds. All real, well-known funds. Rank highest fit first. Expense ratios must be accurate.`;

  // Try models in order — Gemini keeps updating available model names
  const models = [
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-pro'
  ];

  let lastError = '';

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 1500 }
        })
      });

      const rawText = await geminiRes.text();

      if (!geminiRes.ok) {
        lastError = `Model ${model} → HTTP ${geminiRes.status}: ${rawText.slice(0, 200)}`;
        continue; // try next model
      }

      const geminiData = JSON.parse(rawText);
      const content = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!content) {
        lastError = `Model ${model} → empty response`;
        continue;
      }

      const clean = content.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      if (!parsed.funds || !Array.isArray(parsed.funds)) {
        lastError = `Model ${model} → bad JSON structure`;
        continue;
      }

      // Success — return with which model worked
      return res.status(200).json({ ...parsed, _model: model });

    } catch (e) {
      lastError = `Model ${model} → ${e.message}`;
      continue;
    }
  }

  // All models failed
  return res.status(500).json({
    error: `All Gemini models failed. Last error: ${lastError}. Check your GEMINI_API_KEY in Vercel environment variables.`
  });
}
