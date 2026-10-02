/* ═══════════════════════════════════════════════════════════════
   GEMINI PROXY — Vercel serverless function, OOU Study Pro v2.4.2

   This is the VERCEL-shaped twin of netlify/functions/gemini-proxy.js.
   The two platforms use incompatible function signatures — Netlify
   functions export `handler(event)` and return a { statusCode, body }
   object, Vercel functions export a default `handler(req, res)` and
   write directly to `res` — so one file can't serve both platforms.
   This file's BEHAVIOR is intentionally identical to the Netlify one
   (same multi-key failover, same request validation, same diagnostic
   GET endpoint) so the app works the same way regardless of which
   platform it's deployed on. If you change the failover/validation
   logic in one file, change it in the other too — see README →
   "Keeping the two proxy functions in sync".

   Vercel auto-detects any file under /api/ as a serverless function
   and routes /api/gemini-proxy to it — no vercel.json rewrite needed
   for this. See README → "Deploying to Vercel" for full setup.
═══════════════════════════════════════════════════════════════ */

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

/* CORS — this function is designed to be called CROSS-ORIGIN (that's
   the whole point of the hybrid setup: the main site can live on a
   completely different host, e.g. Netlify, while just this function
   lives here). Configure ALLOWED_ORIGINS as a comma-separated env var
   (e.g. "https://precious-examprep.netlify.app,https://studyprov5.netlify.app")
   to restrict which sites' browsers are allowed to call this endpoint.
   Left unset, it allows any origin — fine to start with, but note this
   endpoint has no other access control (no API key, no auth) beyond
   the app's own client-side daily-use limits, which a direct script
   call bypasses entirely regardless of CORS (CORS only restricts
   browser-based cross-site calls, never a server-to-server or curl
   call) — the SAME exposure the Netlify version has always had, not
   something new introduced by this file. Setting ALLOWED_ORIGINS at
   least keeps casual browser-based misuse from other sites out. */
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

  /* Diagnostic GET — same purpose as the Netlify version: visit
     /api/gemini-proxy directly in a browser to check whether Vercel's
     environment variables are actually reaching this function, without
     exposing any key value. On Vercel specifically, remember env vars
     are scoped per-environment (Production / Preview / Development) —
     a key added under "Production" won't show up here on a preview
     deploy unless it's also checked for that environment. */
  if (req.method === 'GET') {
    res.status(200).json({
      ok: apiKeys.length > 0,
      keysDetected: apiKeys.length,
      message: apiKeys.length > 0
        ? `${apiKeys.length} key(s) detected — the function IS seeing your environment variable(s).`
        : 'No GEMINI_API_KEY (or GEMINI_API_KEY_2, _3, …) detected. Check: (1) it\'s added in Vercel → Project → Settings → Environment Variables, (2) the "Environment" checkboxes (Production/Preview/Development) cover whichever one you\'re testing, (3) you\'ve redeployed since adding it — like Netlify, Vercel functions read env vars from the deploy they were built in, not retroactively, (4) no typo in the name (exactly GEMINI_API_KEY, case-sensitive).',
    });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed — POST only.' });
    return;
  }

  if (!apiKeys.length) {
    console.error('[api/gemini-proxy] No GEMINI_API_KEY (or GEMINI_API_KEY_2, _3, …) set in Vercel environment variables.');
    res.status(503).json({ code: 'NO_API_KEY', error: 'AI Study Assistant is not configured yet — no GEMINI_API_KEY is set in this project\'s environment variables. See README.md → "Deploying to Vercel".' });
    return;
  }

  /* Vercel parses a JSON request body into req.body automatically when
     Content-Type is application/json — no manual JSON.parse needed
     (unlike the Netlify version, which gets a raw string event.body). */
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

  /* Retry/fallback — Gemini answers 503 ("high demand") and sometimes
     500/504 for a perfectly valid request. Before this change that
     status was forwarded straight to the browser, which showed it as
     "not set up — add GEMINI_API_KEY". Now: for each model in the chain
     (requested model first, then fallbacks), try every key; on a
     transient status (429/500/503/504) move on. Total time is capped
     below the function's 30s maxDuration. Override the fallbacks with
     the optional FALLBACK_MODELS env var (comma-separated). */
  const fallbacks = (process.env.FALLBACK_MODELS || 'gemini-2.5-flash,gemini-2.5-flash-lite')
    .split(',').map(s => s.trim()).filter(m => /^[a-z0-9.\-]+$/i.test(m) && m !== useModel);
  const models = [useModel, ...fallbacks];
  const RETRYABLE = [429, 500, 503, 504];
  const deadline = Date.now() + 24000;

  let lastResult = null;
  outer:
  for (let m = 0; m < models.length; m++) {
    for (let i = 0; i < apiKeys.length; i++) {
      if (Date.now() > deadline) break outer;
      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${models[m]}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKeys[i] },
            body: JSON.stringify({ contents }),
          }
        );
        const data = await geminiRes.text();

        if (RETRYABLE.includes(geminiRes.status)) {
          console.warn(`[api/gemini-proxy] ${models[m]} key #${i + 1}/${apiKeys.length} -> HTTP ${geminiRes.status}; trying next.`);
          lastResult = { status: geminiRes.status, body: data };
          continue;
        }
        /* A fallback model that doesn't exist (404) or rejects the request
           shouldn't mask the real error from the primary model. */
        if (m > 0 && !geminiRes.ok) { continue; }

        res.status(geminiRes.status).setHeader('Content-Type', 'application/json').send(data);
        return;
      } catch (e) {
        console.error(`[api/gemini-proxy] Fetch failed (${models[m]}, key #${i + 1}):`, e);
        lastResult = {
          status: 502,
          body: JSON.stringify({ error: `Could not reach the AI service: ${e?.name || 'Error'} — ${e?.message || String(e)}` }),
        };
      }
    }
  }

  console.error('[api/gemini-proxy] All models/keys exhausted or failed.');
  res.status(lastResult?.status || 429).setHeader('Content-Type', 'application/json')
    .send(lastResult?.body || JSON.stringify({ error: 'All configured Gemini API keys are currently rate-limited. Please try again shortly.' }));
};
