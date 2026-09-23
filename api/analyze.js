// POST /api/analyze
// Body: { category, risk, horizon, goal }
// Returns: { market_context, funds: [ ...up to 4 funds ], _model }
//
// This function is public, so it (1) accepts only the exact values the page sends,
// (2) keeps the Gemini API key on the server, and (3) cleans everything the model returns
// before the browser inserts it into the page.

// ---- Allowed input values (must match the choices offered in index.html) ----
const CATEGORIES = new Set([
  'Bond and Fixed Income Funds',
  'Dividend Income Funds',
  'ESG and Sustainable Funds',
  'Growth ETFs',
  'International Funds',
  'Real Estate REIT Funds',
  'Technology Sector ETFs',
  'US Index Funds',
]);
const RISKS = new Set(['conservative', 'moderate', 'aggressive']);
const HORIZONS = new Set(['short term (1-3 years)', 'medium term (3-10 years)', 'long term (10+ years)']);
const GOALS = new Set([
  'grow my wealth over time',
  'generate regular income or dividends',
  'preserve capital safely',
  'beat inflation',
]);

// ---- Limits ----
const MAX_FUNDS = 4; // the prompt asks for exactly four funds
const MAX_MODEL_ATTEMPTS = 3; // try at most three Gemini models per request
const REQUEST_TIMEOUT_MS = 20000; // give each Gemini call 20 seconds
const MODEL_CACHE_MS = 10 * 60 * 1000; // remember the model list for 10 minutes

// Module-level cache: survives between requests while the serverless instance stays warm.
let modelCache = { models: [], fetchedAt: 0 };

// Turn a value into safe display text: cut it to a maximum length, then escape HTML characters.
// Cutting first avoids slicing an escape sequence such as "&amp;" in half.
function cleanText(value, maxLength) {
  return String(value ?? '')
    .slice(0, maxLength)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Rebuild the model's answer from scratch using only known fields, so nothing unexpected
// (extra keys, HTML, huge strings) can pass through to the browser.
function sanitizeResult(parsed) {
  const funds = parsed.funds.slice(0, MAX_FUNDS).map((f) => ({
    name: cleanText(f.name, 120),
    ticker: cleanText(f.ticker, 12),
    type: cleanText(f.type, 30),
    issuer: cleanText(f.issuer, 60),
    expense_ratio: cleanText(f.expense_ratio, 20),
    category_tag: cleanText(f.category_tag, 60),
    why_fits: cleanText(f.why_fits, 700),
    key_metric_label: cleanText(f.key_metric_label, 60),
    key_metric_value: cleanText(f.key_metric_value, 60),
    // Keep the score a real number between 0 and 100.
    fit_score: Math.min(100, Math.max(0, Math.round(Number(f.fit_score) || 0))),
    best_for: cleanText(f.best_for, 120),
    watch_out: cleanText(f.watch_out, 400),
  }));
  return { market_context: cleanText(parsed.market_context, 600), funds };
}

// fetch() with a timeout, so a slow upstream cannot hold the function open.
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer); // always stop the timer
  }
}

// Ask Gemini which models this key can use, preferring the cheaper "flash" models.
// The key travels in a header, because keys placed in URLs end up in logs and proxies.
async function getModels(apiKey) {
  // Reuse the cached list while it is fresh.
  if (modelCache.models.length && Date.now() - modelCache.fetchedAt < MODEL_CACHE_MS) {
    return modelCache.models;
  }
  let models;
  try {
    const listRes = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey },
    });
    const listData = await listRes.json();
    models = (listData.models || [])
      .map((m) => m.name.replace('models/', ''))
      .filter((n) => n.includes('flash') || n.includes('pro')) // text-generation families
      .filter((n) => !n.includes('embedding') && !n.includes('aqa') && !n.includes('vision'));
    // Put flash models first: they are faster and cheaper.
    models.sort((a, b) => Number(b.includes('flash')) - Number(a.includes('flash')));
  } catch (e) {
    models = []; // fall through to the fallback list below
  }
  // If listing failed or returned nothing, use a known-good fallback list.
  if (!models.length) {
    models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash-002'];
  }
  modelCache = { models, fetchedAt: Date.now() };
  return models;
}

export default async function handler(req, res) {
  // Same-origin requests need no CORS headers. Cross-origin access is off by default;
  // set ALLOWED_ORIGIN (for example https://fundpick.vercel.app) only if another site must call this.
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin && req.headers.origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  // Answer browser pre-flight checks.
  if (req.method === 'OPTIONS') return res.status(204).end();
  // Only POST does real work.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Pull the four fields out of the request body (an empty object if the body is missing).
  const { category, risk, horizon, goal } = req.body || {};
  // Every field must be one of the exact allowed values. This also blocks prompt injection,
  // because the user can no longer put free text into the prompt.
  if (!CATEGORIES.has(category) || !RISKS.has(risk) || !HORIZONS.has(horizon) || !GOALS.has(goal)) {
    return res.status(400).json({ error: 'Invalid or missing fields' });
  }

  // The Gemini key lives in a Vercel environment variable, never in the code.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set in this deployment');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  // Today's date, so the model can talk about current conditions.
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  // The prompt only contains validated values, and it tells the model to reply with JSON only.
  const prompt = `You are a knowledgeable investment analyst. Today is ${today}.

User investor profile:
- Category interest: ${category}
- Risk tolerance: ${risk}
- Time horizon: ${horizon}
- Primary goal: ${goal}

Return ONLY valid JSON — no markdown, no backticks, no extra text. Use exactly this structure:
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
      "why_fits": "2-3 sentences in plain English explaining why THIS fund fits the user's risk, horizon, and goal. Be concrete and specific.",
      "key_metric_label": "e.g. 10-Year Avg Return",
      "key_metric_value": "e.g. ~11.2% per year",
      "fit_score": 95,
      "best_for": "short phrase e.g. set-and-forget long-term investors",
      "watch_out": "One sentence on the main risk or drawback"
    }
  ]
}

Exactly 4 funds. All real, well-known funds. Rank highest fit first. Expense ratios must be accurate.`;

  // Find which models to try (cached, flash first), and cap the number of attempts.
  const models = (await getModels(apiKey)).slice(0, MAX_MODEL_ATTEMPTS);
  let lastError = ''; // kept for the server log only, never sent to the browser

  for (const model of models) {
    try {
      // Call Gemini. The key goes in a header, not in the URL.
      const geminiRes = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 1500 },
          }),
        }
      );

      // A non-2xx answer means this model is unavailable; try the next one.
      if (!geminiRes.ok) {
        lastError = `${model} -> HTTP ${geminiRes.status}`;
        continue;
      }

      // Read the model's text out of the response.
      const geminiData = await geminiRes.json();
      const content = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!content) {
        lastError = `${model} -> empty response`;
        continue;
      }

      // Models sometimes wrap JSON in code fences even when told not to; strip them, then parse.
      const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
      if (!parsed.funds || !Array.isArray(parsed.funds) || parsed.funds.length === 0) {
        lastError = `${model} -> bad JSON structure`;
        continue;
      }

      // Success: clean every field before sending it to the browser.
      return res.status(200).json({ ...sanitizeResult(parsed), _model: model });
    } catch (e) {
      lastError = `${model} -> ${e.message}`;
    }
  }

  // Every attempt failed. Log the detail for the owner; give the visitor a generic message.
  console.error('All Gemini attempts failed. Last error:', lastError);
  return res.status(502).json({ error: 'The analysis service is temporarily unavailable. Please try again.' });
}
