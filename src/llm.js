// AI calls. Gemini in production; a deterministic mock for offline tests (--mock-llm).
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function makeLlm({ mock, model, temperature, delayMs, log }) {
  if (mock) return mockLlm;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  let last = 0;
  return async function gemini(prompt) {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait); // stay under free-tier rate limits
    last = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature, responseMimeType: 'application/json' }
        })
      });
      if (r.status === 429 || r.status >= 500) { log(`Gemini ${r.status}, retrying`); await sleep(15000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      return JSON.parse(text.replace(/^```json\s*|```$/g, ''));
    }
    throw new Error('Gemini kept failing');
  };
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
