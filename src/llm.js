// AI calls. Gemini in production; a deterministic mock for offline tests (--mock-llm).
const sleep = ms => new Promise(r => setTimeout(r, ms));
const API = 'https://generativelanguage.googleapis.com/v1beta';

// Ask Google which models this key can use, so a retired or overloaded model is not a dead end.
async function listFlashModels(key, preferred, log) {
  try {
    const r = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const names = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /flash/i.test(n) && !/image|tts|audio|live|embedding/i.test(n));
    const rank = n => (/preview|exp/i.test(n) ? 1 : 0) + (/lite/i.test(n) ? 0.5 : 0);
    const ordered = [preferred, ...names.filter(n => n !== preferred).sort((a, b) => rank(a) - rank(b) || b.localeCompare(a))];
    log(`Models available to this key (in fallback order): ${ordered.slice(0, 5).join(', ')}`);
    return ordered;
  } catch (e) {
    log(`Could not list models (${e.message}); using ${preferred} only`);
    return [preferred];
  }
}

export async function makeLlm({ mock, model, temperature, delayMs, log, deadlineMs }) {
  if (mock) return mockLlm;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const models = await listFlashModels(key, model, log);
  let current = 0, last = 0;

  // One request, never longer than 90 s. A hung connection counts as "overloaded", not as a crash.
  async function callOnce(name, prompt) {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait); // stay under free-tier rate limits
    last = Date.now();
    try {
      const r = await fetch(`${API}/models/${name}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(90000),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature, responseMimeType: 'application/json' }
        })
      });
      if (r.status === 429 || r.status >= 500) return { busy: `${r.status}` };
      if (r.status === 404) return { gone: true };
      if (!r.ok) return { fatal: `Gemini ${r.status}: ${(await r.text()).slice(0, 300)}` };
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      try { return { data: JSON.parse(text.replace(/^```json\s*|```$/g, '')) }; }
      catch { return { busy: 'invalid JSON in answer' }; }
    } catch (e) {
      return { busy: e.name === 'TimeoutError' ? 'timed out after 90 s' : `network error (${e.message})` };
    }
  }

  // Overloaded model -> go straight to the next model; only after all are tried, wait and go round again.
  async function gemini(prompt) {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < models.length && i < 4; i++) {
        if (deadlineMs && Date.now() > deadlineMs) throw new Error('time budget for AI calls used up');
        const idx = (current + i) % models.length, name = models[idx];
        const res = await callOnce(name, prompt);
        if (res.data) {
          if (idx !== current) { log(`Switched to ${name} for the rest of the run`); current = idx; }
          gemini.modelUsed = name;
          return res.data;
        }
        if (res.fatal) throw new Error(res.fatal);
        log(`${name}: ${res.gone ? 'not available (404)' : res.busy}, trying the next model`);
      }
      if (round === 0) { log('All models busy, waiting 30 s before one more round'); await sleep(30000); }
    }
    throw new Error('All Gemini models were busy for this call');
  }
  gemini.modelUsed = models[0];
  return gemini;
}

// ---------- mock (only for offline testing of the pipeline, never used in a real run) ----------
const CAT = [
  [/inflation|cpi/i, /\bcpi\b|inflation/i], [/producer|ppi/i, /\bppi\b|producer price/i],
  [/gdp/i, /\bgdp\b/i], [/retail/i, /retail sales/i], [/home sales/i, /home sales|housing/i],
  [/interest-rate|minutes/i, /\bfomc\b|fed minutes|rate decision/i]
];
const COUNTRY = { 'united-states': /\bus\b|u\.s\.|dollar|fed\b/i, 'united-kingdom': /\buk\b|pound|gbp|boe/i, japan: /japan|yen|jpy|boj/i, china: /china|yuan/i, canada: /canada|cad\b|loonie/i, germany: /germany|dax|euro/i };

async function mockLlm(prompt) {
  if (prompt.includes('Task A - matching')) {
    const events = JSON.parse(prompt.split('EVENTS:\n')[1].split('\n\nARTICLES:')[0]);
    const articles = JSON.parse(prompt.split('ARTICLES:\n')[1]);
    const matches = events.map(e => {
      const ids = articles.filter(a => CAT.some(([ec, ar]) => ec.test(e.category + ' ' + e.name) && ar.test(a.title)) && (COUNTRY[e.country] || /$^/).test(a.title)).map(a => a.id);
      return { event_id: e.id, article_ids: ids, reason: 'mock keyword match' };
    });
    const missing = articles.filter(a => /\bcpi\b/i.test(a.title)).slice(0, 1)
      .filter(() => !events.some(e => e.country === 'united-states' && /^(inflation-rate|core-inflation-rate)/.test(e.category)))
      .map(a => ({ release: 'US CPI', article_id: a.id, evidence: a.title }));
    return { matches, missing_releases: missing };
  }
  const name = (prompt.match(/"name": "([^"]+)"/) || [])[1] || 'the release';
  const out = {
    x_pre: `${name} at {time_et} ET. Forecast {forecast}, previous {previous}. A surprise here could move the dollar fast. Full analysis on FXEmpire.`,
    x_post: `${name} came in at {actual} vs {forecast} expected, {direction} forecast. Watch how the dollar reacts into the session.`
  };
  if (prompt.includes('"video_script"')) {
    out.video_script = `HOOK\nOne number could shake the dollar this week. [ON SCREEN: ${name}]\nWHAT IT IS\n${name} lands at {time_et} ET. The forecast is {forecast}, last time it was {previous}. [ON SCREEN: "Forecast {forecast}"]\nWHY IT MATTERS\nThis feeds straight into rate expectations, and rates drive the dollar, gold and stocks. Traders will look at it within seconds of the release, so the first move is often the biggest one of the day. [ON SCREEN: DXY chart]\nWHAT TO WATCH\nA print above the forecast could lift the dollar and pressure gold. A miss could do the opposite. Something close to the forecast may mean a quiet market until the next release. Also watch the revision to last month, it can change the picture. Gold was near 4,500 last week. [ON SCREEN: Gold chart]\nCLOSE\nFull breakdown on FXEmpire. [ON SCREEN: fxempire.com]`;
  }
  return out;
}
