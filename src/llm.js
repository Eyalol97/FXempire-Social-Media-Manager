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

// Providers are tried in order: Gemini (if a key is set), then GitHub Models (free inside GitHub Actions).
// A provider that answers "quota exhausted" for every model is skipped for the rest of the run.
// Keep the configured GitHub models that still exist; if none do, take small chat models from the catalog.
async function githubCatalog(token, wanted, log) {
  try {
    const r = await fetch('https://models.github.ai/catalog/models', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(String(r.status));
    const ids = (await r.json()).map(m => m.id).filter(Boolean);
    const keep = wanted.filter(w => ids.includes(w));
    const extra = ids.filter(i => /mini|flash|small/i.test(i) && !/embed|image|audio|realtime|reason/i.test(i) && !keep.includes(i));
    return [...keep, ...extra].slice(0, 4);
  } catch (e) {
    log(`Could not read the GitHub Models catalog (${e.message}); using the configured list`);
    return wanted;
  }
}

export async function makeLlm({ mock, model, temperature, delayMs, log, deadlineMs, githubModels = [] }) {
  if (mock) return mockLlm;
  const providers = [];
  const gKey = process.env.GEMINI_API_KEY, ghToken = process.env.GITHUB_TOKEN;
  if (gKey) providers.push({ id: 'gemini', key: gKey, models: await listFlashModels(gKey, model, log), last: 0, out: false });
  if (ghToken && githubModels.length) providers.push({ id: 'github', key: ghToken, models: await githubCatalog(ghToken, githubModels, log), last: 0, out: false });
  if (!providers.length) throw new Error('No AI provider: set GEMINI_API_KEY or run inside GitHub Actions');
  log(`AI providers in order: ${providers.map(p => `${p.id} [${p.models.slice(0, 4).join(', ')}]`).join(' -> ')}`);

  async function callOnce(p, name, prompt) {
    const wait = p.last + delayMs - Date.now();
    if (wait > 0) await sleep(wait); // stay under free-tier rate limits
    p.last = Date.now();
    try {
      const r = p.id === 'gemini'
        ? await fetch(`${API}/models/${name}:generateContent`, {
            method: 'POST', signal: AbortSignal.timeout(90000),
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature, responseMimeType: 'application/json' } })
          })
        : await fetch('https://models.github.ai/inference/chat/completions', {
            method: 'POST', signal: AbortSignal.timeout(90000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
            body: JSON.stringify({ model: name, temperature, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] })
          });
      if (r.status === 429 || r.status >= 500) {
        const body = (await r.text()).replace(/\s+/g, ' ');
        const reason = (body.match(/"message":\s*"([^"]{0,220})/) || [])[1] || body.slice(0, 160);
        return { busy: `${r.status} ${reason}`, quota: r.status === 429 };
      }
      if (r.status === 404 || r.status === 400 && p.id === 'github') return { gone: `${r.status} ${(await r.text()).slice(0, 160)}` };
      if (!r.ok) return { fatal: `${p.id} ${r.status}: ${(await r.text()).slice(0, 300)}` };
      const j = await r.json();
      const text = p.id === 'gemini' ? (j.candidates?.[0]?.content?.parts?.map(x => x.text).join('') || '') : (j.choices?.[0]?.message?.content || '');
      try { return { data: JSON.parse(text.replace(/^```json\s*|```$/g, '')) }; }
      catch { return { busy: 'invalid JSON in answer' }; }
    } catch (e) {
      return { busy: e.name === 'TimeoutError' ? 'timed out after 90 s' : `network error (${e.message})` };
    }
  }

  async function ai(prompt) {
    for (let round = 0; round < 2; round++) {
      for (const p of providers) {
        if (p.out) continue;
        let quotaHits = 0, tried = 0;
        for (const name of p.models.slice(0, 4)) {
          if (deadlineMs && Date.now() > deadlineMs) throw new Error('time budget for AI calls used up');
          tried++;
          const res = await callOnce(p, name, prompt);
          if (res.data) {
            if (ai.modelUsed !== `${p.id}/${name}`) log(`Using ${p.id}: ${name}`);
            ai.modelUsed = `${p.id}/${name}`;
            p.models = [name, ...p.models.filter(m => m !== name)]; // stick with what works
            return res.data;
          }
          if (res.fatal) { log(res.fatal); break; }
          if (res.quota) quotaHits++;
          log(`${p.id} ${name}: ${res.gone || res.busy}`);
        }
        if (quotaHits === tried) { p.out = true; log(`${p.id}: every model is over its limit, skipping it for the rest of this run`); }
      }
      if (providers.every(p => p.out)) break;
      if (round === 0) { log('All providers busy, waiting 30 s before one more round'); await sleep(30000); }
    }
    throw new Error('No AI provider could answer this call');
  }
  ai.modelUsed = null;
  return ai;
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
