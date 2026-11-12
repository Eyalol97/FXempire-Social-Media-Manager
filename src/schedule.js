// Posting schedule relative to each event time (T). Offsets come from config so they can be A/B tested.
import { H, M, label, clampToActiveHours, partsIn } from './time.js';

export function buildSchedule(posts, videos, majorHolidays, nowMs, cfg) {
  const t = cfg.timing, tz = cfg.timezone, slots = [];
  const holidayOn = (country, ms) => majorHolidays.find(h => h.country === country && h.date.slice(0, 10) === partsIn(tz, ms).date);

  const add = (r, kind, channel, rawMs, clampKind) => {
    const { ms, moved } = clampKind ? clampToActiveHours(tz, rawMs, t.quietStart, t.quietEnd, clampKind) : { ms: rawMs, moved: false };
    const notes = [];
    if (moved) notes.push(`Moved from ${label(tz, rawMs)} to stay inside ${t.quietStart}-${t.quietEnd} ET`);
    const hol = kind === 'record_by' ? null : holidayOn(r.event.country, ms);
    if (hol) notes.push(`Market holiday listed that day: ${hol.name} (${hol.stock_name || hol.country}), expect thin liquidity`);
    if (ms < nowMs) notes.push('Slot already passed at run time');
    slots.push({ eventId: r.event.id, kind, channel, ms, at: label(tz, ms), notes, passed: ms < nowMs });
  };

  for (const r of posts) {
    add(r, 'x_pre', cfg.channels.x, r.timeMs + t.xPreMinutes * M, 'pre');
    add(r, 'x_post', cfg.channels.x, r.timeMs + t.xPostMinutes * M, 'post');
  }
  for (const r of videos) {
    add(r, 'record_by', 'Tiger (recording)', r.timeMs + t.recordByHours * H, null);
    add(r, 'video', cfg.channels.video.join(' / '), r.timeMs + t.videoPublishHours * H, 'pre');
  }
  return slots.sort((a, b) => a.ms - b.ms);
}
