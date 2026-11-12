// Automated checks that run on every AI draft BEFORE a person sees it.
// They catch mechanical problems so the human review can focus on judgment.

const NUM = /\d[\d,]*(?:\.\d+)?/g;
const norm = s => s.replace(/,/g, '').replace(/\.0+$/, '');

export function fillPlaceholders(text, values) {
  return text.replace(/\{(forecast|previous|actual|time_et|reference|direction)\}/g, (m, k) =>
    values[k] === null || values[k] === undefined || values[k] === '' ? m : values[k]);
}

export function checkDraft(kind, filled, sourceCorpus, cfg) {
  const issues = [];
  const allowed = new Set((sourceCorpus.match(NUM) || []).map(norm));
  // Numbers inside editor cues and placeholders are not checked as claims
  const spoken = filled.replace(/\[ON SCREEN:[^\]]*\]/g, '').replace(/\{[a-z_]+\}/g, '');
  const unverified = [...new Set((spoken.match(NUM) || []).map(norm))].filter(n => !allowed.has(n));
  if (unverified.length) issues.push(`Numbers not found in the source: ${unverified.join(', ')}`);

  if (/\bn\/a\b/i.test(filled)) issues.push('Mentions a figure that does not exist for this release (n/a)');
  const lower = filled.toLowerCase();
  const banned = cfg.guards.bannedPhrases.filter(p => lower.includes(p));
  if (banned.length) issues.push(`Banned phrasing: ${banned.join(', ')}`);

  if (kind.startsWith('x_') && filled.length > cfg.guards.xMaxChars) issues.push(`Too long for X: ${filled.length} characters`);
  if (kind === 'video_script') {
    const words = spoken.replace(/^(HOOK|WHAT IT IS|WHY IT MATTERS|WHAT TO WATCH|CLOSE)$/gm, '').split(/\s+/).filter(Boolean).length;
    if (words < cfg.guards.scriptMinWords || words > cfg.guards.scriptMaxWords) issues.push(`${words} spoken words, target ${cfg.guards.scriptMinWords}-${cfg.guards.scriptMaxWords} (about 45 seconds)`);
  }
  const pending = (filled.match(/\{(actual|direction)\}/g) || []).length > 0;
  return { issues, pending };
}
