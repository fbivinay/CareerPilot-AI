// When the Email page's queue should be fully sent: each email takes the observed pace, and waits until the
// send `cap` places back has left the 24-hour window. A wait longer than one bulk run (~5 min) needs the sender
// restarted (the Email page at the resume time, or the next pipeline run), so it adds RESTART_MS.
// ponytail: fixed restart lag and a pace from the last run, not a model of Gmail's per-minute limiter
// (lib/gmail.mjs paces that); good to minutes, which is what an estimate needs.
const DAY = 24 * 3600_000;
const RUN_MS = 5 * 60_000;
const RESTART_MS = 10 * 60_000;
export const DEFAULT_PACE_MS = 4_000; // ~3.5 s an email seen on GitHub, plus the gap between runs

export function bulkEta({ sentTimes = [], remaining, cap, paceMs = DEFAULT_PACE_MS, nowMs = Date.now() }) {
  if (!(remaining > 0)) return null;
  const t = sentTimes.map(Date.parse).filter((x) => x > nowMs - DAY).sort((a, b) => a - b);
  let at = nowMs;
  for (let i = 0; i < remaining; i++) {
    at += paceMs;
    const free = t.length >= cap ? t[t.length - cap] + DAY : 0;
    if (free > at) at = free + (free - at > RUN_MS ? RESTART_MS : 0);
    t.push(at);
  }
  return at;
}

// Pace of the last run (its start to its latest result), with ~15% for the gap between runs; the default before
// a run has sent enough to measure.
export function observedPace(last) {
  const n = last?.results?.length ?? 0;
  const ms = n >= 5 ? (Date.parse(last.at) - Date.parse(last.startedAt)) / n : NaN;
  return ms > 0 ? ms * 1.15 : DEFAULT_PACE_MS;
}
