// Time helpers. All scheduling math is done in UTC milliseconds; display is in the configured zone.
const H = 3600e3, M = 60e3;
export { H, M };

export function partsIn(tz, ms) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, weekday: p.weekday, minutes: +hour * 60 + +p.minute };
}

export function label(tz, ms) {
  const p = partsIn(tz, ms);
  return `${p.weekday} ${p.date.slice(5)} ${p.time}`;
}

// Moves a slot that falls outside quiet-hours limits to the nearest edge:
// too late -> today's end (for pre-event) or tomorrow's start (for post-event); too early -> start or previous evening.
export function clampToActiveHours(tz, ms, quietStart, quietEnd, kind) {
  const toMin = s => +s.slice(0, 2) * 60 + +s.slice(3);
  const start = toMin(quietStart), end = toMin(quietEnd);
  const { minutes } = partsIn(tz, ms);
  if (minutes >= start && minutes <= end) return { ms, moved: false };
  if (kind === 'pre') {
    // pre-event content must go out BEFORE the event: move back to the previous evening edge
    const back = minutes > end ? (minutes - end) : (minutes + 24 * 60 - end);
    return { ms: ms - back * M, moved: true };
  }
  // post-event: move forward to the next morning edge
  const fwd = minutes < start ? (start - minutes) : (24 * 60 - minutes + start);
  return { ms: ms + fwd * M, moved: true };
}
