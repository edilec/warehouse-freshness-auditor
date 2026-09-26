/**
 * Policy validation: configuration, so every failure throws and nothing here
 * produces a report.
 *
 * Unknown keys are the point. A one-character typo in a limit name, or in
 * `suspendOnNonBusinessDays`, silently restoring a default has turned a real
 * failure into a green run in this catalog, so each closed object is checked
 * for refusal AND for accepting the spelling it is meant to accept.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_LIMITS, PolicyError, validatePolicy } from '../src/index.mjs'
import { BUSINESS_DAYS } from './helpers.mjs'

const TABLE = { name: 'a.table', maxAgeMinutes: 60 }

function document(overrides = {}) {
  return { schemaVersion: '1', tables: [TABLE], ...overrides }
}

test('a minimal policy validates and takes every default limit', () => {
  const result = validatePolicy(document())
  assert.deepEqual(result.limits, { ...DEFAULT_LIMITS })
  assert.deepEqual(result.tables, [{
    name: 'a.table',
    maxAgeMinutes: 60,
    suspendOnNonBusinessDays: false,
    suspendDuringMaintenance: false,
  }])
  assert.equal(result.calendar.businessDays, null)
  assert.deepEqual(result.calendar.maintenanceWindows, [])
  assert.equal(result.calendar.offsetMinutes, 0)
})

test('a limit given explicitly replaces only itself', () => {
  const result = validatePolicy(document({ limits: { maxTables: 7 } }))
  assert.equal(result.limits.maxTables, 7)
  assert.equal(result.limits.maxRuns, DEFAULT_LIMITS.maxRuns)
})

test('a misspelled limit is refused rather than silently ignored', () => {
  assert.throws(() => validatePolicy(document({ limits: { maxTable: 7 } })), /unknown key "maxTable"/u)
})

test('a misspelled suspension flag is refused rather than leaving the table governed', () => {
  assert.throws(
    () => validatePolicy(document({ tables: [{ ...TABLE, suspendOnNonBusinessDay: true }] })),
    /unknown key "suspendOnNonBusinessDay"/u,
  )
  assert.equal(
    validatePolicy(document({
      calendar: { businessDays: BUSINESS_DAYS },
      tables: [{ ...TABLE, suspendOnNonBusinessDays: true }],
    })).tables[0].suspendOnNonBusinessDays,
    true,
  )
})

test('suspendOnNonBusinessDays with no declared working week is refused, not assumed', () => {
  // Inventing Monday to Friday would be this tool deciding somebody's working
  // week for them, silently, and then suspending a real deadline on its say-so.
  assert.throws(
    () => validatePolicy(document({ tables: [{ ...TABLE, suspendOnNonBusinessDays: true }] })),
    /Declare the working week; no default is assumed\./u,
  )
})

test('suspendDuringMaintenance with no windows is legal and suspends nothing', () => {
  const result = validatePolicy(document({ tables: [{ ...TABLE, suspendDuringMaintenance: true }] }))
  assert.equal(result.tables[0].suspendDuringMaintenance, true)
  assert.deepEqual(result.calendar.maintenanceWindows, [])
})

test('maxAgeMinutes is required on every governed table, with no fallback', () => {
  const { maxAgeMinutes, ...noAge } = TABLE
  void maxAgeMinutes
  assert.throws(
    () => validatePolicy(document({ tables: [noAge] })),
    /There is no built-in deadline to fall back on\./u,
  )
  for (const value of [0, -1, 1.5, '60', null]) {
    assert.throws(() => validatePolicy(document({ tables: [{ ...TABLE, maxAgeMinutes: value }] })), PolicyError)
  }
})

test('a duplicate table name is refused', () => {
  assert.throws(() => validatePolicy(document({ tables: [TABLE, TABLE] })), /is declared twice/u)
})

test('a day name outside the seven is refused by naming them', () => {
  assert.throws(
    () => validatePolicy(document({ calendar: { businessDays: ['Monday'] } })),
    /the day names are friday, monday, saturday, sunday, thursday, tuesday, wednesday/u,
  )
  assert.throws(
    () => validatePolicy(document({ calendar: { businessDays: ['monday', 'monday'] } })),
    /names "monday" twice/u,
  )
  assert.throws(() => validatePolicy(document({ calendar: { businessDays: [] } })), /non-empty array/u)
})

test('a window that ends at or before it starts is refused', () => {
  const window = (start, end) => document({
    calendar: { maintenanceWindows: [{ id: 'w', start, end }] },
  })
  assert.throws(
    () => validatePolicy(window('2026-09-18T02:00:00Z', '2026-09-18T02:00:00Z')),
    /covers no instant/u,
  )
  assert.throws(
    () => validatePolicy(window('2026-09-18T03:00:00Z', '2026-09-18T02:00:00Z')),
    /covers no instant/u,
  )
  // One millisecond is a window.
  assert.equal(
    validatePolicy(window('2026-09-18T02:00:00.000Z', '2026-09-18T02:00:00.001Z'))
      .calendar.maintenanceWindows.length,
    1,
  )
})

test('a window instant this tool does not read is refused rather than guessed at', () => {
  assert.throws(
    () => validatePolicy(document({
      calendar: { maintenanceWindows: [{ id: 'w', start: '18/09/2026', end: '2026-09-18T03:00:00Z' }] },
    })),
    /must be an instant written as YYYY-MM-DD/u,
  )
})

test('a window naming a table the policy does not govern is refused', () => {
  assert.throws(
    () => validatePolicy(document({
      calendar: {
        maintenanceWindows: [{
          id: 'w',
          start: '2026-09-18T01:00:00Z',
          end: '2026-09-18T03:00:00Z',
          tables: ['b.table'],
        }],
      },
    })),
    /which is not in "tables"/u,
  )
})

test('a duplicate window id is refused', () => {
  const entry = { id: 'w', start: '2026-09-18T01:00:00Z', end: '2026-09-18T03:00:00Z' }
  assert.throws(
    () => validatePolicy(document({ calendar: { maintenanceWindows: [entry, entry] } })),
    /is declared twice/u,
  )
})

test('an unknown top-level, calendar, table or window key is refused', () => {
  assert.throws(() => validatePolicy(document({ extra: 1 })), /unknown key "extra"/u)
  assert.throws(() => validatePolicy(document({ calendar: { timezone: 'UTC' } })), /unknown key "timezone"/u)
  assert.throws(() => validatePolicy(document({ tables: [{ ...TABLE, owner: 'x' }] })), /unknown key "owner"/u)
  assert.throws(
    () => validatePolicy(document({
      calendar: {
        maintenanceWindows: [{ id: 'w', start: '2026-09-18T01:00:00Z', end: '2026-09-18T03:00:00Z', why: 'x' }],
      },
    })),
    /unknown key "why"/u,
  )
})

test('a name that renders as nothing is refused, however trim reads it', () => {
  const invisible = String.fromCodePoint(0x200e)
  assert.throws(() => validatePolicy(document({ tables: [{ ...TABLE, name: invisible }] })), PolicyError)
})

test('the document itself must be an object of the declared version', () => {
  assert.throws(() => validatePolicy([]), /must be a JSON object/u)
  assert.throws(() => validatePolicy(null), /must be a JSON object/u)
  assert.throws(() => validatePolicy(document({ schemaVersion: 1 })), /must be "1"/u)
  assert.throws(() => validatePolicy({ schemaVersion: '1', tables: [] }), /non-empty array/u)
})
