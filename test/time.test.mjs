/**
 * Instants, days and windows.
 *
 * `Date.parse` is refused everywhere in this tool, so the shapes it would have
 * accepted are tested as refusals here: they are exactly the inputs that would
 * make a freshness verdict depend on the host's time zone.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DAY_MS, DAY_NAMES, MINUTE_MS, dayNameAt, minutesBetween, parseInstant, withinWindow } from '../src/index.mjs'

test('only the two documented instant shapes are read', () => {
  assert.equal(parseInstant('2026-09-18').ms, Date.UTC(2026, 8, 18))
  assert.equal(parseInstant('2026-09-18T09:00:00Z').ms, Date.UTC(2026, 8, 18, 9))
  assert.equal(parseInstant('2026-09-18T09:00:00.250Z').ms, Date.UTC(2026, 8, 18, 9, 0, 0, 250))

  for (const text of [
    '2026-09-18T09:00:00',
    '2026-09-18T09:00:00+05:30',
    '2026-09-18 09:00:00Z',
    '18/09/2026',
    'September 18, 2026',
    '2026-9-8',
    '',
    null,
    7,
  ]) {
    assert.equal(parseInstant(text).ok, false, JSON.stringify(text))
  }
})

test('an impossible date is refused rather than rolled forward', () => {
  assert.equal(parseInstant('2026-02-28').ok, true)
  assert.equal(parseInstant('2026-02-29').ok, false, 'not a leap year')
  assert.equal(parseInstant('2024-02-29').ok, true, 'a leap year')
  assert.equal(parseInstant('2000-02-29').ok, true, 'a leap year by the 400 rule')
  assert.equal(parseInstant('1900-02-29').ok, false, 'not a leap year by the 100 rule')
  assert.equal(parseInstant('2026-02-30').ok, false)
  assert.equal(parseInstant('2026-04-31').ok, false)
  assert.equal(parseInstant('2026-13-01').ok, false)
  assert.equal(parseInstant('2026-00-01').ok, false)
  assert.equal(parseInstant('2026-01-00').ok, false)
})

test('hour 24 and a leap second are refused', () => {
  assert.equal(parseInstant('2026-09-18T23:59:59Z').ok, true)
  assert.equal(parseInstant('2026-09-18T24:00:00Z').ok, false)
  assert.equal(parseInstant('2026-09-18T23:59:60Z').ok, false)
  assert.equal(parseInstant('2026-09-18T23:60:00Z').ok, false)
})

test('every component bound is accepted on its inside, not only refused past it', () => {
  // The two tests above drive the N+1 side of each bound: month 13, month 0,
  // hour 24, second 60. These are the N sides. Widening `month > 12` by one
  // character makes every December instant unreadable, which in this tool means
  // a snapshot generated in December is refused as `snapshot-invalid` -- and
  // the suite that only refuses month 13 stays green while it happens.
  assert.equal(parseInstant('2026-12-25').ms, Date.UTC(2026, 11, 25), 'December')
  assert.equal(parseInstant('2026-12-31T23:59:59.999Z').ms, Date.UTC(2026, 11, 31, 23, 59, 59, 999))
  assert.equal(parseInstant('2026-01-01').ms, Date.UTC(2026, 0, 1), 'month 1 and day 1, the low bounds')
  assert.equal(parseInstant('2026-01-31').ms, Date.UTC(2026, 0, 31), 'the last day of a 31-day month')
})

test('a year under 100 is the year the document wrote, and never the 1900s', () => {
  // `Date.UTC(26, 8, 18)` is 1926-09-18. The language remaps years 0000-0099
  // into 1900-1999 (ECMA-262, MakeFullYear), which is the same class of silent
  // roll this tool refuses `Date.parse` for. A sentinel or zeroed timestamp is
  // an ordinary artefact of a warehouse export, and reading one that way made
  // this tool state a fifty-two-million-minute age as a fact about an instant
  // no document contains.
  assert.equal(parseInstant('0026-09-18T08:30:00Z').ms < parseInstant('1926-09-18T08:30:00Z').ms, true)
  assert.notEqual(parseInstant('0026-09-18').ms, parseInstant('1926-09-18').ms)
  assert.equal(parseInstant('0001-01-01').ms, -62135596800000)
  assert.equal(parseInstant('0000-02-29').ok, true, 'year 0 is a leap year in the proleptic calendar')
  assert.equal(parseInstant('0100-02-29').ok, false, 'a century that is not a multiple of 400')

  // From 0100 on, the arithmetic has to agree with `Date.UTC` exactly -- over
  // the whole range the two shapes can express, not at three sample points.
  let disagreements = 0
  for (let year = 100; year <= 9999; year += 1) {
    for (const [month, day] of [[1, 1], [2, 28], [3, 1], [12, 31]]) {
      const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const parsed = parseInstant(text)
      if (!parsed.ok || parsed.ms !== Date.UTC(year, month - 1, day)) disagreements += 1
    }
  }
  assert.equal(disagreements, 0)
})

test('the day names run from the weekday the epoch fell on', () => {
  assert.equal(DAY_NAMES.length, 7)
  assert.equal(dayNameAt(0, 0), 'thursday', '1970-01-01 was a Thursday')
  const week = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']
  assert.deepEqual(
    week.map((day) => dayNameAt(parseInstant(day).ms, 0)),
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
  )
})

test('an instant before the epoch lands on the day it belongs to', () => {
  // Truncating division would put this on the following day.
  assert.equal(dayNameAt(-1, 0), 'wednesday')
  assert.equal(dayNameAt(-DAY_MS, 0), 'wednesday')
})

test('the calendar offset moves the day boundary and nothing else', () => {
  const lateFriday = parseInstant('2026-09-18T23:30:00Z').ms
  assert.equal(dayNameAt(lateFriday, 0), 'friday')
  assert.equal(dayNameAt(lateFriday, 60), 'saturday', 'one hour ahead')
  assert.equal(dayNameAt(lateFriday, -60), 'friday', 'one hour behind')

  const earlySaturday = parseInstant('2026-09-19T00:30:00Z').ms
  assert.equal(dayNameAt(earlySaturday, 0), 'saturday')
  assert.equal(dayNameAt(earlySaturday, -60), 'friday')
})

test('minutes between two instants round down and never invent a second', () => {
  const base = parseInstant('2026-09-18T09:00:00Z').ms
  assert.equal(minutesBetween(base, base), 0)
  assert.equal(minutesBetween(base, base + MINUTE_MS - 1), 0)
  assert.equal(minutesBetween(base, base + MINUTE_MS), 1)
  assert.equal(minutesBetween(base + MINUTE_MS, base), -1)
})

test('a window includes the instant it starts on and excludes the one it ends on', () => {
  const window = { startMs: 100, endMs: 200 }
  assert.equal(withinWindow(99, window), false)
  assert.equal(withinWindow(100, window), true)
  assert.equal(withinWindow(199, window), true)
  assert.equal(withinWindow(200, window), false)
})
