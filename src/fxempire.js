// Data intake from FXEmpire's public JSON endpoints (the same ones the site's own pages call).
const BASE = 'https://www.fxempire.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (fxe-social-pipeline)', Accept: 'application/json' };

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return r.json();
}

// The API's "last" flag is not reliable (it reported last=true while page 2 still had data),
// so we page until an empty page comes back.
export async function fetchCalendar(tz, impact) {
  const events = [];
  for (const range of ['current-week', 'next-week']) {
    for (let page = 1; page <= 30; page++) {
      const url = `${BASE}/api/v1/en/economic-calendar?page=${page}&timezone=${encodeURIComponent(tz)}&dateRange=${range}&impact=${impact}`;
      const j = await getJson(url);
      const batch = (j.calendar || []).flatMap(d => d.events || []);
      if (!batch.length) break;
      events.push(...batch);
    }
  }
  return events;
}

export async function fetchArticles(pages) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const j = await getJson(`${BASE}/api/v1/en/articles/hub/forecasts?size=20&page=${page}`);
    for (const a of j.articles || []) {
      out.push({
        id: a.id, title: a.title, tags: a.tags || [], timestamp: a.timestamp,
        articleUrl: a.articleUrl, author: a.author?.name || a.author || ''
      });
    }
  }
  return out;
}

// Article body and key points come from the page's embedded Next.js data.
export async function fetchArticleBody(articleUrl) {
  const r = await fetch(BASE + articleUrl, { headers: { ...HEADERS, Accept: 'text/html' } });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) return null;
  let found = null;
  (function walk(o) {
    if (found || !o || typeof o !== 'object') return;
    if ('articleBody' in o && 'title' in o) { found = o; return; }
    for (const k in o) walk(o[k]);
  })(JSON.parse(m[1]));
  if (!found) return null;
  const kp = found.articleKeyPoints;
  const keyPoints = Array.isArray(kp) ? kp.map(x => (typeof x === 'string' ? x : x?.text || '')).filter(Boolean) : [];
  return { body: String(found.articleBody || ''), keyPoints };
}
