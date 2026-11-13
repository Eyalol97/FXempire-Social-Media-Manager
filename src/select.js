// Deterministic part of the system: filtering, holiday handling, scoring, ranking, skip reasons.
// No AI here, so every rank can be explained and reproduced.
import { H } from './time.js';

export function tagClasses(tags, map) {
  const classes = new Set();
  for (const t of tags) {
    for (const [prefix, cls] of Object.entries(map)) {
      if (prefix.endsWith('-') ? t.startsWith(prefix) : t === prefix) classes.add(cls);
    }
  }
  return classes;
}

// Readable instrument names from article tags (e.g. co-gold -> Gold, c-eur-usd -> EUR/USD, i-spx -> S&P 500)
const NAMES = { 'i-spx': 'S&P 500', 'i-tech100-usd': 'Nasdaq 100', 'i-us30-usd': 'Dow Jones', 'us-dollar-index': 'US Dollar Index',
  'co-gold': 'Gold', 'co-silver': 'Silver', 'co-wti-crude-oil': 'WTI Oil', 'co-brent-crude-oil': 'Brent Oil', 'co-natural-gas': 'Natural Gas',
  'cc-bitcoin': 'Bitcoin', 'cc-ethereum': 'Ethereum' };
export function instrumentNames(tags) {
  const out = [];
  for (const t of tags) {
    if (NAMES[t]) out.push(NAMES[t]);
    else if (/^c-[a-z]{3}-[a-z]{3}$/.test(t)) out.push(t.slice(2).toUpperCase().replace('-', '/'));
  }
  return [...new Set(out)];
}

// Asset class of a readable instrument name, so breadth can be counted from the instruments actually listed
export function instrumentClass(name) {
  if (/\/|Dollar Index/.test(name)) return 'forex';
  if (/S&P|Nasdaq|Dow|DAX|Nikkei|FTSE/.test(name)) return 'stocks';
  if (/Gold|Silver|Oil|Gas|Copper/.test(name)) return 'commodities';
  if (/Bitcoin|Ethereum/.test(name)) return 'crypto';
  return null;
}

// Default instruments by country when no article is matched (so the "why" column is never empty)
const COUNTRY_DEFAULT = {
  'united-states': ['US Dollar Index', 'EUR/USD', 'S&P 500', 'Gold'],
  'united-kingdom': ['GBP/USD', 'EUR/GBP', 'FTSE 100'], 'euro-area': ['EUR/USD', 'DAX'], germany: ['EUR/USD', 'DAX'],
  japan: ['USD/JPY', 'Nikkei 225'], canada: ['USD/CAD'], china: ['AUD/USD', 'Copper', 'WTI Oil'], australia: ['AUD/USD']
};

export function splitEvents(raw, cfg) {
  const holidays = [], releases = [], seen = new Set();
  for (const e of raw) {
    if (e.allDay || !e.category) {
      const key = `${e.date.slice(0, 10)}|${e.country}|${e.name}`; // same holiday is listed once per exchange
      if (seen.has(key)) continue;
      seen.add(key);
      holidays.push(e);
    } else if (!seen.has('id' + e.id)) {
      seen.add('id' + e.id);
      releases.push(e);
    }
  }
  const majorHolidays = holidays.filter(h => cfg.majorMarkets.includes(h.country));
  return { releases: groupReleases(releases, cfg), holidays, majorHolidays };
}

// Releases from the same country at the same minute are one market moment (e.g. UK GDP YoY + QoQ + MoM).
// They become one event with components, so they don't take several content slots.
function groupReleases(releases, cfg) {
  const groups = new Map();
  for (const e of releases) {
    const k = `${e.country}|${e.date}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const tier = e => cfg.scoring.tierByCategory[e.category] || cfg.scoring.tierDefault;
  return [...groups.values()].map(g => {
    const primary = [...g].sort((a, b) => tier(b) - tier(a))[0];
    const components = g.map(e => ({ name: e.name, forecast: e.forecast, previous: e.previous, actual: e.actual, reference: e.reference }));
    return { ...primary, components, alsoReleased: g.filter(e => e !== primary).map(e => e.name) };
  });
}

const countryName = c => ({ 'united-states': 'US', 'united-kingdom': 'UK', 'euro-area': 'Euro Area' })[c] || c.replace(/-/g, ' ').replace(/\b\w/g, x => x.toUpperCase());

export function scoreAndRank(releases, matches, articlesById, nowMs, cfg) {
  const s = cfg.scoring;
  const windowStart = nowMs - cfg.lookbackHours * H;
  const windowEnd = nowMs + cfg.windowDays * 24 * H;
  const ranked = [], skipped = [];

  for (const e of releases) {
    const t = Date.parse(e.date);
    if (e.impact < cfg.selection.impactGate) { skipped.push({ event: e, rule: 'Not High impact' }); continue; }
    if (t < windowStart) { skipped.push({ event: e, rule: `Already happened (over ${cfg.lookbackHours} hours ago) - too late to post` }); continue; }
    if (t > windowEnd) { skipped.push({ event: e, rule: `Too far ahead (over ${cfg.windowDays} days away) - a later run will cover it` }); continue; }

    const matchedIds = (matches[e.id] || []).filter(id => articlesById[id]);
    const tags = matchedIds.flatMap(id => articlesById[id].tags);
    const coverage = matchedIds.length ? s.coveragePoints : 0;
    const currency = s.currencyPoints[e.country] || 0;
    // Breadth counts only asset classes that the event type moves AND that appear in the instruments we list for it.
    // (Earlier version took the classes from the event type alone, so Canada CPI got 3 classes with only USD/CAD listed.)
    const allInstruments = matchedIds.length ? instrumentNames(tags) : (COUNTRY_DEFAULT[e.country] || []);
    const catClasses = new Set(s.breadthByCategory[e.category] || s.breadthDefault);
    const classes = new Set(allInstruments.map(instrumentClass).filter(c => c && catClasses.has(c)));
    for (const c of tagClasses(tags, cfg.tagClasses)) classes.add(c); // FXEmpire's own article tags count as evidence
    const breadth = Math.min(classes.size, s.breadthMax);
    const tier = s.tierByCategory[e.category] || s.tierDefault;
    const instruments = allInstruments.filter(n => classes.has(instrumentClass(n))); // shown instruments match the score

    ranked.push({
      event: e, timeMs: t,
      score: coverage + currency + breadth, tier,
      parts: { coverage, currency, breadth },
      assetClasses: [...classes], instruments: instruments.slice(0, 6),
      articleIds: matchedIds,
      why: [
        coverage ? `Covered by ${matchedIds.length} FXEmpire article(s)` : 'No FXEmpire article yet',
        currency ? `${countryName(e.country)} release (+${currency})` : 'Currency outside the core list (+0)',
        classes.size ? `Moves ${[...classes].join(', ')} (+${breadth})` : 'No listed instrument in a class this event moves (+0)'
      ]
    });
  }

  // Score first, then tier (rate decisions > inflation/jobs/GDP > rest), then the earlier event.
  ranked.sort((a, b) => b.score - a.score || b.tier - a.tier || a.timeMs - b.timeMs);
  ranked.forEach((r, i) => { r.rank = i + 1; });

  const posts = ranked.slice(0, cfg.selection.topPosts);
  for (const r of ranked.slice(cfg.selection.topPosts)) skipped.push({ event: r.event, rule: `Ranked #${r.rank}, below the top ${cfg.selection.topPosts}`, score: r.score });

  // Videos: need enough lead time for Tiger + editor, and a spread across currencies and days.
  const videos = [], perCur = {}, perDay = {};
  for (const r of ranked) {
    if (videos.length >= cfg.selection.topVideos) break;
    if (r.timeMs + cfg.timing.recordByHours * H < nowMs) continue; // Tiger's record-by deadline already passed
    const day = r.event.date.slice(0, 10);
    if ((perCur[r.event.country] || 0) >= cfg.selection.videoMaxPerCurrency) continue;
    if ((perDay[day] || 0) >= cfg.selection.videoMaxPerDay) continue;
    perCur[r.event.country] = (perCur[r.event.country] || 0) + 1;
    perDay[day] = (perDay[day] || 0) + 1;
    r.video = true;
    videos.push(r);
  }
  return { ranked, posts, videos, skipped };
}
