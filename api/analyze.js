export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { category, risk, horizon, goal } = req.body;
  if (!category || !risk || !horizon || !goal) {
    return res.status(400).json({ error: 'Missing required fields' });
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
      "why_fits": "2-3 sentences in plain English explaining why THIS fund specifically fits the user's risk level, time horizon, and goal. Be concrete — directly reference their inputs, not generic praise.",
      "key_metric_label": "e.g. 10-Year Avg Return",
      "key_metric_value": "e.g. ~11.2% per year",
      "fit_score": 95,
      "best_for": "short phrase e.g. set-and-forget long-term investors",
      "watch_out": "One sentence on the main risk or drawback the investor should know about"
    }
  ]
}

Rules:
- Exactly 4 funds. All must be real, well-known funds that actually exist.
- fit_score is 0-100 based on how well the fund matches this user's specific inputs.
- Rank from highest fit score first to lowest last.
- Expense ratios must match real known values.
- why_fits must directly reference the user's risk tolerance, time horizon, and goal.`;

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1500
        }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(500).json({ error: 'Gemini API error', detail: errText });
    }

    const geminiData = await geminiRes.json();
    const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
