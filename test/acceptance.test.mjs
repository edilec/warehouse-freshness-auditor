/**
 * The acceptance criteria, item by item:
 *
 *   "Late upstream data propagates a clear cause; absent history is unknown;
 *    weekends and maintenance windows follow policy."
 *
 * The first test in this file is the GOOD case. A finding raised on correct
 * input is the worst defect a checker can have -- it sends somebody to fix what
 * was already right -- so silence on a warehouse that met every deadline is
 * checked before anything else.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { auditSnapshot } from '../src/index.mjs'
import {
  BUSINESS_DAYS,
  cleanup,
  findingsFor,
  ms,
  policy,
  project,
  ruleIds,
  snapshot,
} from './helpers.mjs'

after(cleanup)

const NOW = '2026-09-18T09:00:00Z'

const CHAIN_POLICY = policy({
  limits: { maxSnapshotAgeMinutes: 120 },
  tables: [
    { name: 'raw.orders', maxAgeMinutes: 60 },
    { name: 'stage.orders_clean', maxAgeMinutes: 90 },
    { name: 'mart.orders_daily', maxAgeMinutes: 120 },
  ],
})

function chainSnapshot(refreshes) {
  return snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'raw.orders', lastRefreshAt: refreshes.raw, upstream: [] },
      { name: 'stage.orders_clean', lastRefreshAt: refreshes.stage, upstream: ['raw.orders'] },
      { name: 'mart.orders_daily', lastRefreshAt: refreshes.mart, upstream: ['stage.orders_clean'] },
    ],
  })
}

async function audit(policyDocument, snapshotDocument, now = NOW) {
  const { policyPath, snapshotPath } = await project(policyDocument, snapshotDocument)
  return auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(now) })
}

test('a warehouse that met every deadline produces no findings at all', async () => {
  const report = await audit(CHAIN_POLICY, chainSnapshot({
    raw: '2026-09-18T08:30:00Z',
    stage: '2026-09-18T08:40:00Z',
    mart: '2026-09-18T08:50:00Z',
  }))
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 3)
})

test('a table exactly at its limit is not late, and one minute past it is', async () => {
  const onTime = await audit(CHAIN_POLICY, chainSnapshot({
    raw: '2026-09-18T08:00:00Z',
    stage: '2026-09-18T08:30:00Z',
    mart: '2026-09-18T08:00:00Z',
  }))
  // raw is 60 minutes old against a 60 minute limit; mart is 60 against 120.
  assert.deepEqual(onTime.findings, [])

  const justPast = await audit(CHAIN_POLICY, chainSnapshot({
    raw: '2026-09-18T07:59:00Z',
    stage: '2026-09-18T08:30:00Z',
    mart: '2026-09-18T08:00:00Z',
  }))
  assert.deepEqual(ruleIds(justPast), ['table-late'])
  assert.match(justPast.findings[0].message, /raw\.orders is 61 minutes old, above its 60 minute limit\./u)
})

test('late upstream data propagates a clear cause through the whole chain', async () => {
  const report = await audit(CHAIN_POLICY, chainSnapshot({
    raw: '2026-09-18T02:10:00Z',
    stage: '2026-09-18T02:30:00Z',
    mart: '2026-09-18T02:50:00Z',
  }))

  assert.equal(report.status, 'fail')
  assert.equal(report.summary.late, 3)

  // The table with no late upstream is the one blamed for itself.
  const local = findingsFor(report, 'table-late')
  assert.equal(local.length, 1)
  assert.match(local[0].message, /^raw\.orders is 410 minutes old/u)

  const propagated = findingsFor(report, 'table-late-upstream')
  assert.equal(propagated.length, 2)
  const deepest = propagated.find((finding) => finding.message.startsWith('mart.orders_daily'))
  assert.match(
    deepest.message,
    /upstream chain mart\.orders_daily <- stage\.orders_clean <- raw\.orders is late at its far end: raw\.orders is 410 minutes old/u,
  )
  assert.deepEqual(deepest.location, { file: 'snapshot.json', pointer: '/tables/2' })
})

test('a table late on its own is not blamed on an upstream that is fresh', async () => {
  const report = await audit(CHAIN_POLICY, chainSnapshot({
    raw: '2026-09-18T08:30:00Z',
    stage: '2026-09-18T08:40:00Z',
    mart: '2026-09-18T02:50:00Z',
  }))
  assert.deepEqual(ruleIds(report), ['table-late'])
  assert.match(report.findings[0].message, /^mart\.orders_daily is 370 minutes old/u)
  assert.equal(report.findings[0].message.includes('upstream'), false)
})

test('absent history is unknown: neither fresh nor late', async () => {
  const report = await audit(CHAIN_POLICY, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'raw.orders', lastRefreshAt: '2026-09-18T08:30:00Z' },
      { name: 'stage.orders_clean', upstream: ['raw.orders'] },
      { name: 'mart.orders_daily', lastRefreshAt: '2026-09-18T08:50:00Z', upstream: ['stage.orders_clean'] },
    ],
  }))

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['refresh-history-absent'])
  // Presence beside absence: neither verdict was reached for that table, and
  // the report says which table and why.
  assert.equal(ruleIds(report).includes('table-late'), false)
  assert.equal(report.summary.unknown, 1)
  assert.equal(report.summary.checked, 2)
  assert.deepEqual(report.findings[0].location, { file: 'snapshot.json', pointer: '/tables/1' })
  assert.match(report.findings[0].message, /reported as neither fresh nor late/u)
})

test('a completed run supplies the history that lastRefreshAt does not', async () => {
  const report = await audit(CHAIN_POLICY, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'raw.orders', lastRefreshAt: '2026-09-18T08:30:00Z' },
      { name: 'stage.orders_clean' },
      { name: 'mart.orders_daily', lastRefreshAt: '2026-09-18T08:50:00Z' },
    ],
    runs: [
      { table: 'stage.orders_clean', runId: 'run-7', state: 'complete', endedAt: '2026-09-18T08:40:00Z' },
    ],
  }))
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 3)
})

test('lastRefreshAt equal to its completed run ends is the ordinary consistent export', async () => {
  // This is what a correct exporter writes: the table's lastRefreshAt IS the
  // instant its last completed run ended. `refreshOf` only calls the snapshot
  // self-contradictory when a run ended STRICTLY LATER than the declared
  // refresh, and the equal case had no test -- so widening that comparison by
  // one character turned the most ordinary export into `refresh-history-conflict`
  // and exit 2, with the whole suite green.
  const report = await audit(CHAIN_POLICY, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'raw.orders', lastRefreshAt: '2026-09-18T08:30:00Z' },
      { name: 'stage.orders_clean', lastRefreshAt: '2026-09-18T08:40:00Z' },
      { name: 'mart.orders_daily', lastRefreshAt: '2026-09-18T08:50:00Z' },
    ],
    runs: [
      { table: 'raw.orders', runId: 'run-1', state: 'complete', endedAt: '2026-09-18T08:30:00Z' },
      { table: 'stage.orders_clean', runId: 'run-2', state: 'complete', endedAt: '2026-09-18T08:40:00Z' },
      { table: 'mart.orders_daily', runId: 'run-3', state: 'complete', endedAt: '2026-09-18T08:50:00Z' },
    ],
  }))
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 3)

  // One millisecond later on one run is a real disagreement, and is reported.
  const later = await audit(CHAIN_POLICY, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'raw.orders', lastRefreshAt: '2026-09-18T08:30:00Z' },
      { name: 'stage.orders_clean', lastRefreshAt: '2026-09-18T08:40:00Z' },
      { name: 'mart.orders_daily', lastRefreshAt: '2026-09-18T08:50:00Z' },
    ],
    runs: [
      { table: 'raw.orders', runId: 'run-1', state: 'complete', endedAt: '2026-09-18T08:30:00.001Z' },
    ],
  }))
  assert.equal(later.status, 'incomplete')
  assert.deepEqual(ruleIds(later), ['refresh-history-conflict'])
})

test('an age is stated from the instant the document wrote, including a year under 100', async () => {
  // `Date.UTC` remaps years 0000-0099 into 1900-1999, so a zeroed or sentinel
  // lastRefreshAt was read as 1926 and the report stated a specific
  // 52,596,030-minute age as a fact about an instant no document contains.
  const report = await audit(
    policy({ tables: [{ name: 'raw.x', maxAgeMinutes: 60 }] }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [{ name: 'raw.x', lastRefreshAt: '0026-09-18T08:30:00Z' }],
    }),
  )
  assert.deepEqual(ruleIds(report), ['table-late'])
  const trueAge = Math.floor((ms(NOW) - ms('0026-09-18T08:30:00Z')) / 60000)
  assert.equal(trueAge, 1051898430)
  assert.match(report.findings[0].message, new RegExp(`is ${trueAge} minutes old`, 'u'))
})

test('a run that did not complete does not establish a refresh', async () => {
  const report = await audit(CHAIN_POLICY, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'raw.orders', lastRefreshAt: '2026-09-18T08:30:00Z' },
      { name: 'stage.orders_clean' },
      { name: 'mart.orders_daily', lastRefreshAt: '2026-09-18T08:50:00Z' },
    ],
    runs: [
      { table: 'stage.orders_clean', runId: 'run-7', state: 'failed', endedAt: '2026-09-18T08:40:00Z' },
      { table: 'stage.orders_clean', runId: 'run-8', state: 'running', startedAt: '2026-09-18T08:55:00Z' },
    ],
  }))
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['refresh-history-absent'])
})

test('a late table whose upstream cannot be judged reports the lateness and the gap apart', async () => {
  // stage.orders_clean is not governed, so there is no deadline to judge it
  // against. Blaming mart.orders_daily for its own lateness would be a claim
  // about a table this run never evaluated.
  const report = await audit(
    policy({
      limits: { maxSnapshotAgeMinutes: 120 },
      tables: [{ name: 'mart.orders_daily', maxAgeMinutes: 120 }],
    }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'stage.orders_clean', lastRefreshAt: '2026-09-18T02:30:00Z' },
        { name: 'mart.orders_daily', lastRefreshAt: '2026-09-18T02:50:00Z', upstream: ['stage.orders_clean'] },
      ],
    }),
  )

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report).sort(), ['cause-undetermined', 'table-late'])
  assert.match(
    findingsFor(report, 'cause-undetermined')[0].message,
    /stage\.orders_clean could not be judged \(the policy declares no maxAgeMinutes for it\)/u,
  )
  assert.match(
    findingsFor(report, 'cause-undetermined')[0].message,
    /would be a claim about tables this run did not evaluate/u,
  )
})

test('governing that upstream turns the same run into a settled cause', async () => {
  // The mirror of the test above, and the reason it is not vacuous: the only
  // difference is one deadline the policy now declares.
  const report = await audit(
    policy({
      limits: { maxSnapshotAgeMinutes: 120 },
      tables: [
        { name: 'stage.orders_clean', maxAgeMinutes: 90 },
        { name: 'mart.orders_daily', maxAgeMinutes: 120 },
      ],
    }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'stage.orders_clean', lastRefreshAt: '2026-09-18T02:30:00Z' },
        { name: 'mart.orders_daily', lastRefreshAt: '2026-09-18T02:50:00Z', upstream: ['stage.orders_clean'] },
      ],
    }),
  )

  assert.equal(report.status, 'fail')
  assert.deepEqual(ruleIds(report).sort(), ['table-late', 'table-late-upstream'])
  assert.equal(ruleIds(report).includes('cause-undetermined'), false)
})

test('an upstream the snapshot does not hold is a lineage gap, not a settled cause', async () => {
  const report = await audit(
    policy({
      limits: { maxSnapshotAgeMinutes: 120 },
      tables: [{ name: 'mart.orders_daily', maxAgeMinutes: 120 }],
    }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'mart.orders_daily', lastRefreshAt: '2026-09-18T02:50:00Z', upstream: ['raw.absent'] },
      ],
    }),
  )

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report).sort(), ['cause-undetermined', 'table-late', 'upstream-unknown'])
  assert.match(
    findingsFor(report, 'upstream-unknown')[0].message,
    /names raw\.absent as an upstream, and the snapshot holds no row for that table/u,
  )
})

test('weekends follow the policy: only a table that opts in is suspended', async () => {
  const weekendPolicy = policy({
    limits: { maxSnapshotAgeMinutes: 120 },
    calendar: { offsetMinutes: 0, businessDays: BUSINESS_DAYS },
    tables: [
      { name: 'opted.in', maxAgeMinutes: 60, suspendOnNonBusinessDays: true },
      { name: 'opted.out', maxAgeMinutes: 60 },
    ],
  })
  const stale = snapshot({
    generatedAt: '2026-09-19T01:00:00Z',
    tables: [
      { name: 'opted.in', lastRefreshAt: '2026-09-18T01:00:00Z' },
      { name: 'opted.out', lastRefreshAt: '2026-09-18T01:00:00Z' },
    ],
  })

  const saturday = await audit(weekendPolicy, stale, '2026-09-19T02:00:00Z')
  assert.equal(saturday.summary.suspended, 1)
  assert.equal(saturday.summary.checked, 1)
  assert.deepEqual(ruleIds(saturday).sort(), ['sla-suspended-non-business-day', 'table-late'])
  assert.match(
    findingsFor(saturday, 'sla-suspended-non-business-day')[0].message,
    /falls on a saturday, which the policy's businessDays does not include/u,
  )

  // The same documents on a business day: both tables are compared.
  const friday = await audit(weekendPolicy, snapshot({
    generatedAt: '2026-09-18T01:00:00Z',
    tables: [
      { name: 'opted.in', lastRefreshAt: '2026-09-17T01:00:00Z' },
      { name: 'opted.out', lastRefreshAt: '2026-09-17T01:00:00Z' },
    ],
  }), '2026-09-18T02:00:00Z')
  assert.equal(friday.summary.suspended, 0)
  assert.equal(friday.summary.checked, 2)
  assert.deepEqual(ruleIds(friday), ['table-late', 'table-late'])
})

test('a maintenance window suspends only inside itself, and only for a table that opts in', async () => {
  const windowPolicy = policy({
    limits: { maxSnapshotAgeMinutes: 1440 },
    calendar: {
      offsetMinutes: 0,
      maintenanceWindows: [{ id: 'weekly-vacuum', start: '2026-09-18T01:00:00Z', end: '2026-09-18T03:00:00Z' }],
    },
    tables: [
      { name: 'opted.in', maxAgeMinutes: 60, suspendDuringMaintenance: true },
      { name: 'opted.out', maxAgeMinutes: 60 },
    ],
  })
  const documents = snapshot({
    generatedAt: '2026-09-18T00:30:00Z',
    tables: [
      { name: 'opted.in', lastRefreshAt: '2026-09-17T20:00:00Z' },
      { name: 'opted.out', lastRefreshAt: '2026-09-17T20:00:00Z' },
    ],
  })

  const inside = await audit(windowPolicy, documents, '2026-09-18T02:00:00Z')
  assert.equal(inside.summary.suspended, 1)
  assert.deepEqual(ruleIds(inside).sort(), ['sla-suspended-maintenance', 'table-late'])
  assert.match(
    findingsFor(inside, 'sla-suspended-maintenance')[0].message,
    /falls inside maintenance window weekly-vacuum/u,
  )

  const after = await audit(windowPolicy, documents, '2026-09-18T03:00:00Z')
  assert.equal(after.summary.suspended, 0)
  assert.deepEqual(ruleIds(after), ['table-late', 'table-late'])
})

test('a window that names tables applies only to those tables', async () => {
  const report = await audit(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440 },
      calendar: {
        maintenanceWindows: [{
          id: 'inventory-rebuild',
          start: '2026-09-18T01:00:00Z',
          end: '2026-09-18T03:00:00Z',
          tables: ['named.one'],
        }],
      },
      tables: [
        { name: 'named.one', maxAgeMinutes: 60, suspendDuringMaintenance: true },
        { name: 'named.two', maxAgeMinutes: 60, suspendDuringMaintenance: true },
      ],
    }),
    snapshot({
      generatedAt: '2026-09-18T00:30:00Z',
      tables: [
        { name: 'named.one', lastRefreshAt: '2026-09-17T20:00:00Z' },
        { name: 'named.two', lastRefreshAt: '2026-09-17T20:00:00Z' },
      ],
    }),
    '2026-09-18T02:00:00Z',
  )
  assert.equal(report.summary.suspended, 1)
  assert.deepEqual(ruleIds(report).sort(), ['sla-suspended-maintenance', 'table-late'])
  assert.match(findingsFor(report, 'table-late')[0].message, /^named\.two/u)
})

test('a run where the policy suspended every deadline is not read as a clean warehouse', async () => {
  const report = await audit(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440 },
      calendar: { businessDays: BUSINESS_DAYS },
      tables: [{ name: 'only.table', maxAgeMinutes: 60, suspendOnNonBusinessDays: true }],
    }),
    snapshot({
      generatedAt: '2026-09-19T01:00:00Z',
      tables: [{ name: 'only.table', lastRefreshAt: '2026-09-17T01:00:00Z' }],
    }),
    '2026-09-19T02:00:00Z',
  )

  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.suspended, 1)
  assert.deepEqual(ruleIds(report).sort(), ['no-deadline-in-force', 'sla-suspended-non-business-day'])
  assert.match(
    findingsFor(report, 'no-deadline-in-force')[0].message,
    /This run compared no age against a limit\./u,
  )
  // A policy-directed non-evaluation is an answer, not a gap, so it is not
  // dressed up as an incomplete run -- but it is never silent either.
  assert.equal(report.status, 'pass')
})

test('a late upstream whose deadline the policy suspended is named as suspended, not as late', async () => {
  // One report used to contain two findings that contradict each other:
  // `sla-suspended-maintenance` saying raw.orders "was not compared against its
  // deadline", and `table-late-upstream` asserting in the same report that
  // raw.orders "is 480 minutes old, above its 60 minute limit" -- then telling
  // the operator to recover, first, a table the policy had deliberately
  // excused. The attribution itself is right and stays: raw.orders really has
  // not refreshed, and that really is why mart.orders is late. What was wrong
  // was saying WHICH fact it rests on. A deadline the policy took out of force
  // is not a deadline the upstream missed.
  const suspendedUpstream = policy({
    limits: { maxSnapshotAgeMinutes: 1440 },
    calendar: {
      maintenanceWindows: [{ id: 'w1', start: '2026-09-18T07:00:00Z', end: '2026-09-18T12:00:00Z' }],
    },
    tables: [
      { name: 'raw.orders', maxAgeMinutes: 60, suspendDuringMaintenance: true },
      { name: 'mart.orders', maxAgeMinutes: 120 },
    ],
  })
  const documents = snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'raw.orders', lastRefreshAt: '2026-09-18T01:00:00Z' },
      { name: 'mart.orders', lastRefreshAt: '2026-09-18T02:00:00Z', upstream: ['raw.orders'] },
    ],
  })

  const report = await audit(suspendedUpstream, documents)
  assert.deepEqual(ruleIds(report), ['sla-suspended-maintenance', 'table-late-upstream'])
  const propagated = findingsFor(report, 'table-late-upstream')[0]

  // The lateness of the reported table, and the age of the upstream, are both
  // facts this run established, and both are still stated.
  assert.match(propagated.message, /^mart\.orders is 420 minutes old, above its 120 minute limit/u)
  assert.match(propagated.message, /raw\.orders is 480 minutes old/u)

  // What may not be said is that the upstream is above a limit that is in
  // force for it, in a report that also says it was not compared against one.
  assert.equal(propagated.message.includes('above its 60 minute limit'), false)
  assert.match(propagated.message, /the policy has taken out of force for it \(maintenance window w1\)/u)
  assert.match(propagated.message, /reported as suspended rather than late/u)
  assert.equal(propagated.suggestion, 'Decide in the policy whether this table is suspended alongside its upstream.')

  // The same lineage with the suspension lifted keeps the plain wording, so
  // this test cannot be satisfied by a tool that never says "above its limit".
  const outside = await audit(suspendedUpstream, documents, '2026-09-18T12:00:00Z')
  const plain = findingsFor(outside, 'table-late-upstream')[0]
  assert.match(plain.message, /raw\.orders is 660 minutes old, above its 60 minute limit\.$/u)
  assert.equal(plain.suggestion, 'Recover the upstream at the far end of the chain first.')
  assert.equal(plain.message.includes('out of force'), false)
})

test('a non-business-day suspension names the day it rests on in the upstream finding', async () => {
  // The second suspension kind takes the other branch of the same sentence.
  const report = await audit(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440 },
      calendar: { businessDays: BUSINESS_DAYS },
      tables: [
        { name: 'raw.orders', maxAgeMinutes: 60, suspendOnNonBusinessDays: true },
        { name: 'mart.orders', maxAgeMinutes: 120 },
      ],
    }),
    snapshot({
      generatedAt: '2026-09-19T01:00:00Z',
      tables: [
        { name: 'raw.orders', lastRefreshAt: '2026-09-19T00:00:00Z' },
        { name: 'mart.orders', lastRefreshAt: '2026-09-19T00:10:00Z', upstream: ['raw.orders'] },
      ],
    }),
    '2026-09-19T06:00:00Z',
  )
  const propagated = findingsFor(report, 'table-late-upstream')[0]
  assert.match(
    propagated.message,
    /out of force for it \(the instant given to --now falls on a saturday\)/u,
  )
  assert.equal(propagated.message.includes('above its 60 minute limit'), false)
})
