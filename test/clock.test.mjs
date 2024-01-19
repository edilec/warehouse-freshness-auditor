/**
 * The clock, pinned BEHAVIOURALLY.
 *
 * The README says this tool reads no clock. A source scan for `Date.now` would
 * be a declaration about the behaviour rather than the behaviour -- and it
 * would miss `new Date()` with no argument, `Date.parse`, and anything a future
 * edit reaches for instead.
 *
 * So every clock read is made to THROW for the duration of the audit, and the
 * audit is required to complete and produce the same report it produces
 * normally. `Date.UTC` stays available, because it is arithmetic over numbers
 * the caller supplied and reads nothing.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { auditSnapshot, renderReport } from '../src/index.mjs'
import { BUSINESS_DAYS, cleanup, ms, policy, project, snapshot } from './helpers.mjs'

after(cleanup)

/** Everything that could tell this process what time it is, made to throw. */
function withNoClock(body) {
  const RealDate = globalThis.Date
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) throw new Error('a clock was read: new Date()')
      return Reflect.construct(target, args, newTarget)
    },
    get(target, property, receiver) {
      if (property === 'now' || property === 'parse') {
        return () => {
          throw new Error(`a clock was read: Date.${String(property)}`)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  try {
    return body()
  } finally {
    globalThis.Date = RealDate
  }
}

test('the guard itself catches a clock read, so the tests below are not vacuous', () => {
  assert.throws(() => withNoClock(() => Date.now()), /a clock was read: Date\.now/u)
  assert.throws(() => withNoClock(() => new Date()), /a clock was read: new Date/u)
  assert.throws(() => withNoClock(() => Date.parse('2026-09-18')), /a clock was read: Date\.parse/u)
  // Arithmetic over supplied numbers is untouched.
  assert.equal(withNoClock(() => Date.UTC(2026, 8, 18)), Date.UTC(2026, 8, 18))
})

test('a full audit completes with every clock read made to throw', async () => {
  const { policyPath, snapshotPath } = await project(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440 },
      calendar: {
        offsetMinutes: 330,
        businessDays: BUSINESS_DAYS,
        maintenanceWindows: [{ id: 'w', start: '2026-09-18T01:00:00Z', end: '2026-09-18T03:00:00Z' }],
      },
      tables: [
        { name: 'raw.orders', maxAgeMinutes: 60 },
        { name: 'mart.orders_daily', maxAgeMinutes: 120, suspendDuringMaintenance: true },
        { name: 'mart.absent', maxAgeMinutes: 60 },
      ],
    }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'raw.orders', lastRefreshAt: '2026-09-18T01:00:00Z' },
        { name: 'mart.orders_daily', lastRefreshAt: '2026-09-18T01:30:00Z', upstream: ['raw.orders'] },
      ],
      runs: [{ table: 'raw.orders', runId: 'r-1', state: 'complete', endedAt: '2026-09-18T01:00:00Z' }],
    }),
  )
  const now = ms('2026-09-18T09:00:00Z')

  const normal = renderReport(await auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now }))
  const guarded = await withNoClock(() => auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now }))

  assert.equal(renderReport(guarded), normal)
  assert.equal(guarded.status, 'incomplete')
  assert.equal(guarded.findings.length > 0, true)
})
