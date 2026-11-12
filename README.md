# FXEmpire social content pipeline

Turns FXEmpire's economic calendar and analyst forecast articles into a week of reviewable social drafts (X posts and 45-second video scripts for Tiger), with a posting schedule. Nothing is posted automatically.

## Flow
1. **Intake** (code): FXEmpire calendar API (High impact, current + next week, ET) and the latest forecast articles.
2. **Clean** (code): holidays are separated and de-duplicated (one row per exchange), releases from the same country at the same minute are grouped (UK GDP YoY/QoQ/MoM = one event).
3. **Match** (Gemini, `prompts/match.md`): which articles discuss which release, and which major releases the articles mention that are missing from the calendar.
4. **Score and rank** (code, `config.json`): High impact gate, coverage +3, currency (USD 2, EUR/GBP/JPY/CAD 1), asset-class breadth up to 3. Tie-break: event tier, then time. Top 8 get X posts; top 3 get videos (max 2 per currency and per day, and Tiger's record-by deadline must still be ahead).
5. **Draft** (Gemini, `prompts/draft.md` + `prompts/video.md`): the model writes with placeholders like `{forecast}`; the code fills in the real numbers.
6. **Automatic checks** (code, `src/guard.js`): every number must appear in the source data or article text, X length, script word count (about 45 s), banned advice phrasing, no "n/a" figures. A failing draft is sent back once with the problems listed, then marked "Failed auto-check".
7. **Schedule** (code): X pre T-90 min, X post T+10 min, video T-20 h, Tiger record-by T-48 h, kept inside 07:00-21:00 ET. Major-market holidays become schedule notes.
8. **Human review** (board in `public/`): approve, edit or reject each draft before anything goes out.

## Setup (about 10 minutes)
1. Create a Gemini API key at https://aistudio.google.com/apikey (free tier).
2. Push this folder to a new GitHub repository.
3. In the repo: Settings > Secrets and variables > Actions > New repository secret: `GEMINI_API_KEY`.
   Optional variable `GEMINI_MODEL` to override the model in `config.json`.
4. Actions tab > "Weekly content run" > Run workflow. It also runs daily at 06:17 ET.
5. Vercel: Add New Project > import the repo > deploy (no build step; it serves `public/`). Each run commits `public/data.json`, and Vercel redeploys.

## Local test without network or AI
`npm test` runs the whole pipeline on `fixtures/snapshot.json` (real calendar rows and article titles captured on 12 Nov 2026) with a stand-in AI.
