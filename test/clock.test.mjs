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

/**
 * Everything that could tell this process what time it is, made to throw.
 *
 * `await body()` inside the try, and not `return body()`, is the whole guard.
 * The audit is ASYNC: a `finally` that fires when the promise is merely
 * RETURNED restores the real `Date` before the first `await` inside
 * `readPolicy` has even resumed, so only the synchronous prefix of the run is
 * covered. That is how this test file shipped, and `Date.now()` injected as the
 * first statement of `auditFreshness` -- the heart of the run -- left the whole
 * suite green while the header of this file claimed the opposite.
 *
 * Awaiting means the guard is installed across event-loop turns, so the tests
 * below must stay sequential; `node --test` runs the tests in one file in order
 * unless a file asks otherwise, and this one does not.
 */
async function withNoClock(body) {
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
    return await body()
  } finally {
    globalThis.Date = RealDate
  }
}

test('the guard itself catches a clock read, so the tests below are not vacuous', async () => {
  await assert.rejects(withNoClock(() => Date.now()), /a clock was read: Date\.now/u)
  await assert.rejects(withNoClock(() => new Date()), /a clock was read: new Date/u)
  await assert.rejects(withNoClock(() => Date.parse('2026-09-18')), /a clock was read: Date\.parse/u)
  // Arithmetic over supplied numbers is untouched.
  assert.equal(await withNoClock(() => Date.UTC(2026, 8, 18)), Date.UTC(2026, 8, 18))
})

test('the guard survives an await, which is the whole point of it', async () => {
  // The self-check above is synchronous, and a synchronous body is exactly the
  // case the broken version handled correctly -- which is what hid the hole.
  // This one reads the clock only AFTER yielding to the event loop, so it fails
  // against a `withNoClock` whose finally fires when the promise is returned.
  await assert.rejects(
    withNoClock(async () => {
      await Promise.resolve()
      await new Promise((resolve) => { setImmediate(resolve) })
      return Date.now()
    }),
    /a clock was read: Date\.now/u,
  )

  // And it is taken down again afterwards, so nothing below runs guarded by
  // accident: a leaked proxy would make every later Date.now() throw.
  assert.equal(Number.isFinite(Date.now()), true)
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

  // Reading the documents, auditing them and RENDERING the report all happen
  // inside the guard: rendering outside it would leave the last stage of the
  // run unguarded for the same reason the whole run used to be.
  const guarded = await withNoClock(async () => {
    const report = await auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now })
    return { report, rendered: renderReport(report) }
  })

  assert.equal(guarded.rendered, normal)
  assert.equal(guarded.report.status, 'incomplete')
  assert.equal(guarded.report.findings.length > 0, true)
})
