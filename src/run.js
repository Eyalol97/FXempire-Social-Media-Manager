// Orchestrator: calendar + articles -> ranked events -> drafts -> schedule -> public/data.json
// Usage: node src/run.js            (live: FXEmpire + Gemini)
//        node src/run.js --fixture fixtures/snapshot.json --mock-llm   (offline test)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCalendar, fetchArticles, fetchArticleBody } from './fxempire.js';
import { splitEvents, scoreAndRank } from './select.js';
import { buildSchedule } from './schedule.js';
import { makeLlm } from './llm.js';
import { fillPlaceholders, checkDraft } from './guard.js';
import { H, partsIn, label } from './time.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fixture = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null;
const mock = args.includes('--mock-llm');
const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'public/data.json';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const model = process.env.GEMINI_MODEL || cfg.llm.model;
const prompt = name => fs.readFileSync(path.join(ROOT, 'prompts', name), 'utf8');
const COUNTRY_LABEL = { 'united-states': 'US', 'united-kingdom': 'UK', 'euro-area': 'Euro Area' };
const runLog = [];
const log = m => { const line = `${new Date().toISOString()} ${m}`; runLog.push(line); console.log(line); };

async function main() {
  // 1. Intake
  let rawEvents, articles, nowMs;
  if (fixture) {
    const snap = JSON.parse(fs.readFileSync(path.join(ROOT, fixture), 'utf8'));
    rawEvents = snap.events; articles = snap.articles; nowMs = Date.parse(snap.capturedAt);
    log(`Fixture mode: ${fixture} (now = ${snap.capturedAt})`);
  } else {
    nowMs = Date.now();
    rawEvents = await fetchCalendar(cfg.timezone, cfg.selection.impactGate);
    articles = await fetchArticles(cfg.articles.pages);
  }
  log(`Calendar: ${rawEvents.length} high-impact rows. Articles: ${articles.length}`);

  // 2. Filter holidays (and de-duplicate them: one row per exchange)
  const { releases, holidays, majorHolidays } = splitEvents(rawEvents, cfg);
  log(`Releases: ${releases.length}. Holidays after de-dup: ${holidays.length} (major markets: ${majorHolidays.length})`);

  const winStart = nowMs - cfg.lookbackHours * H, winEnd = nowMs + cfg.windowDays * 24 * H;
  const inWindow = releases.filter(e => { const t = Date.parse(e.date); return t >= winStart && t <= winEnd; });
  const recent = articles.filter(a => nowMs - a.timestamp <= cfg.articles.maxAgeHours * H);
  const articlesById = Object.fromEntries(articles.map(a => [a.id, a]));

  const llm = await makeLlm({ mock, model, temperature: cfg.llm.temperature, delayMs: cfg.llm.delayMs, log });

  // 3. AI step 1: match articles to events + spot releases missing from the calendar
  const evList = inWindow.map(e => ({ id: e.id, country: e.country, name: e.name, category: e.category, reference: e.reference, time_et: label(cfg.timezone, Date.parse(e.date)) }));
  const artList = recent.map(a => ({ id: a.id, title: a.title, tags: a.tags.filter(t => /^(c|co|i|s|cc)-|us-dollar-index|economic-news/.test(t)) }));
  let matchOut = { matches: [], missing_releases: [] };
  try {
    matchOut = await llm(prompt('match.md').replace('{{events}}', () => JSON.stringify(evList, null, 1)).replace('{{articles}}', () => JSON.stringify(artList, null, 1)));
  } catch (err) {
    log(`Matching failed (${err.message}). Continuing without article coverage points.`);
  }
  const matches = {};
  for (const m of matchOut.matches || []) {
    const ids = (m.article_ids || []).filter(id => articlesById[id]); // drop ids the model invented
    if (ids.length) matches[m.event_id] = ids;
  }
  const missing = (matchOut.missing_releases || []).filter(x => articlesById[x.article_id]).map(x => ({
    ...x, title: articlesById[x.article_id].title, url: 'https://www.fxempire.com' + articlesById[x.article_id].articleUrl
  }));
  log(`Matched ${Object.keys(matches).length} events to articles. Releases missing from calendar: ${missing.length}`);

  // 4. Deterministic scoring and ranking
  const { ranked, posts, videos, skipped } = scoreAndRank(releases, matches, articlesById, nowMs, cfg);
  for (const h of holidays) skipped.push({ event: h, rule: cfg.majorMarkets.includes(h.country) ? 'Market holiday (used as a schedule flag, not content)' : 'Market holiday outside major markets' });
  log(`Ranked ${ranked.length}. Posts: ${posts.length}. Videos: ${videos.length}`);

  // 5. AI step 2: drafts, then automated checks, one retry with the problems listed
  const drafts = [];
  for (const r of posts) {
    const e = r.event, tMs = r.timeMs;
    const ctxArticles = r.articleIds.slice(0, 2).map(id => articlesById[id]);
    let context = '';
    for (const a of ctxArticles) {
      const b = fixture ? null : await fetchArticleBody(a.articleUrl);
      context += `ARTICLE: ${a.title} (by ${a.author})\n` + (b ? `${b.keyPoints.join('\n')}\n${b.body.slice(0, cfg.articles.bodyChars)}\n` : '') + '\n';
    }
    const direction = e.actual == null || e.actual === '' ? null : ({ above: 'above', below: 'below' }[e.color] || 'in line with');
    const values = { forecast: e.forecast || 'n/a', previous: e.previous || 'n/a', actual: e.actual ?? null, time_et: partsIn(cfg.timezone, tMs).time, reference: e.reference || '', direction };
    const facts = {
      name: `${COUNTRY_LABEL[e.country] || e.country.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} ${e.name}`, country: e.country, reference_period: e.reference,
      release_time: `${label(cfg.timezone, tMs)} ET`, forecast: values.forecast, previous: values.previous,
      actual: values.actual ?? 'not released yet', SURPRISE_DIRECTION: direction ?? 'unknown until release',
      instruments: r.instruments,
      released_together: e.components && e.components.length > 1 ? e.components : undefined
    };
    const corpus = JSON.stringify(facts) + ' ' + context;
    let p = prompt('draft.md').replace('{{facts}}', () => JSON.stringify(facts, null, 1)).replace('{{context}}', () => context || '(none)')
      .replace('{{video_instructions}}', () => (r.video ? prompt('video.md') : '')).replace('{{video_key}}', r.video ? ', "video_script": "..."' : '');

    const attempts = [];
    let out, checked;
    let aiError = null;
    for (let i = 0; i <= cfg.llm.maxRetries; i++) {
      try { out = await llm(p); } catch (err) { aiError = err.message; log(`Drafting failed for ${e.name} (${e.country}): ${aiError}`); break; }
      checked = {};
      for (const kind of ['x_pre', 'x_post', ...(r.video ? ['video_script'] : [])]) {
        const filled = fillPlaceholders(out[kind] || '', values);
        checked[kind] = { raw: out[kind] || '', text: filled, ...checkDraft(kind, filled, corpus, cfg) };
      }
      const problems = Object.entries(checked).flatMap(([k, c]) => c.issues.map(x => `${k}: ${x}`));
      attempts.push({ attempt: i + 1, problems });
      if (!problems.length) break;
      log(`Draft for ${e.name} (${e.country}) failed checks: ${problems.join(' | ')}`);
      p += `\n\nYOUR PREVIOUS ANSWER FAILED THESE CHECKS, FIX THEM AND RETURN THE FULL JSON AGAIN:\n${problems.join('\n')}\nPrevious answer:\n${JSON.stringify(out)}`;
    }
    if (aiError && !checked) {
      for (const kind of ['x_pre', 'x_post', ...(r.video ? ['video_script'] : [])]) {
        drafts.push({ eventId: e.id, kind, text: '', raw: '', issues: [`AI call failed: ${aiError}`], status: 'needs_fix', sources: ctxArticles.map(a => ({ title: a.title, url: 'https://www.fxempire.com' + a.articleUrl })), attempts });
      }
      continue;
    }
    for (const [kind, c] of Object.entries(checked)) {
      drafts.push({
        eventId: e.id, kind, text: c.text, raw: c.raw, issues: c.issues,
        status: c.issues.length ? 'needs_fix' : c.pending ? 'waiting_for_actual' : 'ready_for_review',
        sources: ctxArticles.map(a => ({ title: a.title, url: 'https://www.fxempire.com' + a.articleUrl })),
        attempts
      });
    }
  }

  // 6. Schedule
  const schedule = buildSchedule(posts, videos, majorHolidays, nowMs, cfg);
  for (const d of drafts) {
    const slot = schedule.find(s => s.eventId === d.eventId && s.kind === (d.kind === 'video_script' ? 'video' : d.kind));
    if (slot) { d.slotMs = slot.ms; d.slotAt = slot.at; d.channel = slot.channel; }
  }

  // 7. Output for the board
  const ev = r => ({ id: r.event.id, name: r.event.name, alsoReleased: r.event.alsoReleased || [], components: r.event.components || [], country: r.event.country, reference: r.event.reference, at: label(cfg.timezone, r.timeMs), ms: r.timeMs, forecast: r.event.forecast, previous: r.event.previous, actual: r.event.actual });
  const data = {
    runAt: new Date().toISOString(), now: new Date(nowMs).toISOString(), nowLabel: label(cfg.timezone, nowMs),
    mode: fixture ? 'fixture + mock AI (offline test)' : `live: FXEmpire API + ${llm.modelUsed || model}`,
    timezone: cfg.timezone, config: { selection: cfg.selection, scoring: { coveragePoints: cfg.scoring.coveragePoints, currencyPoints: cfg.scoring.currencyPoints, breadthMax: cfg.scoring.breadthMax }, timing: cfg.timing },
    counts: { rawRows: rawEvents.length, releases: releases.length, holidays: holidays.length, inWindow: inWindow.length, articles: recent.length },
    flags: {
      missingReleases: missing,
      holidays: majorHolidays.map(h => ({ date: h.date.slice(0, 10), country: h.country, name: h.name, exchange: h.stock_name }))
    },
    ranked: ranked.map(r => ({ ...ev(r), rank: r.rank, score: r.score, parts: r.parts, tier: r.tier, instruments: r.instruments, assetClasses: r.assetClasses, why: r.why, post: posts.includes(r), video: !!r.video,
      sources: r.articleIds.map(id => ({ title: articlesById[id].title, url: 'https://www.fxempire.com' + articlesById[id].articleUrl })) })),
    skipped: skipped.map(s => ({ name: s.event.name, country: s.event.country, at: s.event.allDay || !s.event.category ? s.event.date.slice(0, 10) + ' (all day)' : label(cfg.timezone, Date.parse(s.event.date)), rule: s.rule, score: s.score ?? null })),
    drafts, schedule, log: runLog
  };
  fs.mkdirSync(path.dirname(path.join(ROOT, outFile)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, outFile), JSON.stringify(data, null, 1));
  log(`Wrote ${outFile}: ${drafts.length} drafts, ${schedule.length} slots`);
}

main().catch(err => { console.error(err); process.exit(1); });
