function collectApiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  for (let i = 2; i <= 30; i++) {
    const v = process.env[`GEMINI_API_KEY_${i}`];
    if (v) keys.push(v);
  }
  return keys;
}

function isValidContents(contents) {
  if (!Array.isArray(contents) || !contents.length) return false;
  return contents.every(turn =>
    turn && typeof turn === 'object' &&
    Array.isArray(turn.parts) && turn.parts.length > 0
  );
}

function corsHeaders(req) {
  const allowlist = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const allowOrigin = !allowlist.length ? '*' : (allowlist.includes(origin) ? origin : allowlist[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

module.exports = async (req, res) => {
  const cors = corsHeaders(req);
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const apiKeys = collectApiKeys();

  if (req.method === 'GET') {
    res.status(200).json({
      ok: apiKeys.length > 0,
      keysDetected: apiKeys.length,
      message: apiKeys.length > 0
        ? `${apiKeys.length} key(s) detected — the function IS seeing your environment variable(s).`
        : 'No GEMINI_API_KEY (or GEMINI_API_KEY_2, _3, …) detected. Check: (1) it\'s added in Vercel → Project → Settings → Environment Variables, (2) the "Environment" checkboxes (Production/Preview/Development) cover whichever one you\'re testing, (3) you\'ve redeployed since adding it, (4) no typo in the name.',
    });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed — POST only.' });
    return;
  }

  if (!apiKeys.length) {
    console.error('[api/gemini-proxy] No GEMINI_API_KEY set.');
    res.status(503).json({ error: 'AI Study Assistant is not configured yet — no GEMINI_API_KEY is set in this project\'s environment variables.' });
    return;
  }

  const payload = req.body || {};
  const { prompt, model } = payload;
  let contents;

  if (payload.contents !== undefined) {
    if (!isValidContents(payload.contents)) {
      res.status(400).json({ error: 'Malformed "contents" array in request body.' });
      return;
    }
    contents = payload.contents;
  } else if (typeof prompt === 'string' && prompt) {
    contents = [{ parts: [{ text: prompt }] }];
  } else {
    res.status(400).json({ error: 'Missing "prompt" or "contents" in request body.' });
    return;
  }

  const approxSize = Buffer.byteLength(JSON.stringify(contents), 'utf8');
  if (approxSize > 20 * 1024 * 1024) {
    res.status(413).json({ error: 'Request too large.' });
    return;
  }

  const useModel = (typeof model === 'string' && /^[a-z0-9.\-]+$/i.test(model)) ? model : 'gemini-flash-latest';

  let lastResult = null;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
          body: JSON.stringify({ contents }),
        }
      );
      const data = await geminiRes.text();

      if (geminiRes.status === 429 && i < apiKeys.length - 1) {
        console.warn(`[api/gemini-proxy] Key #${i + 1}/${apiKeys.length} hit 429 — failing over.`);
        lastResult = { status: geminiRes.status, body: data };
        continue;
      }

      res.status(geminiRes.status).setHeader('Content-Type', 'application/json').send(data);
      return;
    } catch (e) {
      console.error(`[api/gemini-proxy] Fetch to Gemini failed on key #${i + 1}/${apiKeys.length}:`, e);
      lastResult = {
        status: 502,
        body: JSON.stringify({ error: `Could not reach the AI service: ${e?.name || 'Error'} — ${e?.message || String(e)}` }),
      };
      continue;
    }
  }

  console.error(`[api/gemini-proxy] All ${apiKeys.length} key(s) exhausted or failed.`);
  res.status(lastResult?.status || 429).setHeader('Content-Type', 'application/json')
    .send(lastResult?.body || JSON.stringify({ error: 'All configured Gemini API keys are currently rate-limited.' }));
};
