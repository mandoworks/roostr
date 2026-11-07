'use strict';
// Central definition and helpers for DeepSeek surge warning windows.
//
// Asset-routing doctrine: weekdays 01:00-04:00 UTC and 06:00-10:00 UTC, at 2x.
// Warning only: never auto-throttles or switches models. Clock is injectable.

const SURGE_MULTIPLIER = 2;

// Windows in UTC (hours and minutes).
const SURGE_WINDOWS_UTC = [
  { startHour: 1, startMinute: 0, endHour: 4, endMinute: 0 },
  { startHour: 6, startMinute: 0, endHour: 10, endMinute: 0 },
];

function isDeepSeekModel(model) {
  if (!model || typeof model !== 'string') return false;
  return /deepseek/i.test(model);
}

function isWeekdayUtc(date) {
  const day = date.getUTCDay();
  // 0 = Sunday, 6 = Saturday; 1..5 = Monday..Friday
  return day >= 1 && day <= 5;
}

function checkSurge(now = Date.now()) {
  const d = new Date(now);
  if (!isWeekdayUtc(d)) {
    return { inSurge: false, multiplier: 1, window: null, windowEnd: null };
  }

  const currentMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();

  for (const win of SURGE_WINDOWS_UTC) {
    const startMins = win.startHour * 60 + win.startMinute;
    const endMins = win.endHour * 60 + win.endMinute;

    if (currentMinutes >= startMins && currentMinutes < endMins) {
      const windowEnd = new Date(Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        win.endHour,
        win.endMinute,
        0,
        0
      )).getTime();

      return {
        inSurge: true,
        multiplier: SURGE_MULTIPLIER,
        window: win,
        windowEnd,
      };
    }
  }

  return { inSurge: false, multiplier: 1, window: null, windowEnd: null };
}

function isSurgeWindow(now = Date.now()) {
  return checkSurge(now).inSurge;
}

function formatLocalEndTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function surgeBanner(model, now = null) {
  const effectiveNow = now !== null ? now : (model && model.now ? model.now : Date.now());
  const surgeInfo = checkSurge(effectiveNow);
  if (!surgeInfo.inSurge) return null;

  const rows = model && Array.isArray(model.rows) ? model.rows : [];
  const affected = rows.filter((r) => {
    const m = r.model && typeof r.model === 'object' ? r.model.v : r.model;
    return isDeepSeekModel(m);
  });

  if (!affected.length) return null;

  const who = affected.map((r) => r.name || r.paneId).join(' · ');
  const ends = formatLocalEndTime(surgeInfo.windowEnd);
  return {
    kind: 'surge',
    text: `▲ 2× SURGE: ${who} (ends ${ends})`,
    affected: affected.map((r) => r.paneId),
  };
}

module.exports = {
  SURGE_MULTIPLIER,
  SURGE_WINDOWS_UTC,
  isDeepSeekModel,
  isWeekdayUtc,
  checkSurge,
  isSurgeWindow,
  formatLocalEndTime,
  surgeBanner,
};
