/**
 * Instants, days and windows.
 *
 * Nothing in this file reads a clock. There is no `Date.now()`, no `new Date()`
 * with no argument and no `Date.parse` anywhere in this tool: the present is a
 * value the caller supplies with `--now`, and every age in a report is
 * arithmetic between that value and a timestamp in the snapshot. That is what
 * makes two runs over the same documents produce byte-identical output, and it
 * is the difference between a freshness auditor you can put in a test and one
 * whose answers depend on when it happened to run.
 *
 * `Date.parse` is refused for a second reason. It accepts implementation
 * defined formats, treats a bare `YYYY-MM-DD` as UTC but `YYYY-MM-DDTHH:MM:SS`
 * as local time, and silently rolls `2026-02-30` forward into March. Every
 * instant here is parsed by the two strict shapes below and range checked.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u

export const MINUTE_MS = 60000
export const DAY_MS = 86400000

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

export function parseInstant(text) {
  if (typeof text !== 'string') return { ok: false }
  const match = DATE_TIME.exec(text) ?? DATE_ONLY.exec(text)
  if (match === null) return { ok: false }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const [hour, minute, second] = [Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)]
  const milli = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'))
  if (month < 1 || month > 12) return { ok: false }
  if (day < 1 || day > daysInMonth(year, month)) return { ok: false }
  // 24:00:00 and a leap second are both refused: neither is a point this tool
  // can order against another without inventing what the exporter meant.
  if (hour > 23 || minute > 59 || second > 59) return { ok: false }
  return { ok: true, ms: Date.UTC(year, month - 1, day, hour, minute, second, milli) }
}

/**
 * The seven day names, in the order the epoch produces them.
 *
 * 1970-01-01T00:00:00Z was a Thursday, so the day index derived from whole days
 * since the epoch starts there. The list is written in that rotation rather
 * than starting at Monday precisely so that no separate offset constant can
 * drift away from it.
 */
export const DAY_NAMES = Object.freeze([
  'thursday', 'friday', 'saturday', 'sunday', 'monday', 'tuesday', 'wednesday',
])

/** The weekday an instant falls on, once shifted into the policy's offset. */
export function dayNameAt(ms, offsetMinutes) {
  const shifted = ms + offsetMinutes * MINUTE_MS
  // `Math.floor` rather than a truncating division, so an instant before the
  // epoch lands on the day it belongs to instead of the one after it.
  const days = Math.floor(shifted / DAY_MS)
  return DAY_NAMES[((days % 7) + 7) % 7]
}

/**
 * Whether an instant falls inside a window.
 *
 * Half open, `[start, end)`. A window that ended exactly at this instant is
 * over: the closed form would leave two adjacent windows overlapping at their
 * shared edge, and a table would be suspended for one millisecond it is not.
 */
export function withinWindow(ms, window) {
  return ms >= window.startMs && ms < window.endMs
}

/** Whole minutes between two instants, rounded down, never negative here. */
export function minutesBetween(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / MINUTE_MS)
}
