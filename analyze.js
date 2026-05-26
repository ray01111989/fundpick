export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { category, risk, horizon, goal } = req.body;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const prompt = `You are a knowledgeable investment analyst. Today is ${today}.

User profile:
- Category: ${category}
- Risk tolerance: ${risk}
- Time horizon: ${horizon}
- Goal: ${goal}

Return ONLY valid JSON (no markdown, no backticks, no extra text). Use this exact structure:
{
  "market_context": "1-2 sentences about current conditions for this category and why it matters to this specific investor right now",
  "funds": [
    {
      "name": "Full Official Fund Name",
      "ticker": "TICK",
      "type": "ETF or Mutual Fund",
      "issuer": "Vanguard / Fidelity / iShares / Schwab / etc",
      "expense_ratio": "0.03%",
      "category_tag": "e.g. Large-Cap Blend",
      "why_fits": "2-3 sentences in plain English explaining why THIS fund fits the user's specific risk level, time horizon, and goal. Be concrete and specific — not generic praise.",
      "key_metric_label": "e.g. 10-Year Avg Return",
      "key_metric_value": "e.g. ~11.2% per year",
      "fit_score": 95,
      "best_for": "short phrase e.g. set-and-forget long-term investors",
      "watch_out": "One sentence on the main risk or drawback the investor should know"
    }
  ]
}

Rules:
- Exactly 4 funds. All must be real, well-known funds that actually exist.
- fit_score is 0-100 based on how well the fund matches the user's specific inputs.
- Rank from highest fit score (#1) to lowest (#4).
- Mix ETFs and Mutual Funds where appropriate for the category.
- Expense ratios must be accurate to known real values.
- why_fits must directly reference the user's risk, horizon, and goal — not generic marketing language.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Anthropic API error', detail: err });
    }

    const data = await response.json();
    const raw = data.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
