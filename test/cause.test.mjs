/**
 * Attributing a cause, at the edges a sweep found nothing defending.
 *
 * `classify` answers a different question from the main loop -- "is this
 * upstream late?" rather than "is this governed table late?" -- and its
 * boundaries were reachable only through a lineage walk, which no test drove
 * until a mutation sweep pointed at them.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { auditSnapshot, byCodeUnit, refreshOf, readSnapshot, suspensionFor, DEFAULT_LIMITS } from '../src/index.mjs'
import { cleanup, findingsFor, ms, policy, project, ruleIds, snapshot, workspace, writeJson } from './helpers.mjs'
import { join } from 'node:path'

after(cleanup)

const NOW = '2026-09-18T09:00:00Z'

async function audit(policyDocument, snapshotDocument, now = NOW) {
  const { policyPath, snapshotPath } = await project(policyDocument, snapshotDocument)
  return auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(now) })
}

const governs = (...entries) => policy({
  limits: { maxSnapshotAgeMinutes: 1440 },
  tables: entries,
})

test('an upstream exactly at its deadline is not the cause of a late downstream', async () => {
  // raw.orders is 60 minutes old against a 60 minute limit, which is fresh.
  // Widening that comparison by one would blame it for its downstream.
  const report = await audit(
    governs({ name: 'raw.orders', maxAgeMinutes: 60 }, { name: 'mart.daily', maxAgeMinutes: 120 }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'raw.orders', lastRefreshAt: '2026-09-18T08:00:00Z' },
        { name: 'mart.daily', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['raw.orders'] },
      ],
    }),
  )
  assert.deepEqual(ruleIds(report), ['table-late'])
  assert.match(findingsFor(report, 'table-late')[0].message, /^mart\.daily/u)
  assert.equal(findingsFor(report, 'table-late')[0].suggestion, 'Check the job that refreshes this table.')

  // One minute older and it becomes the cause, which is what makes the
  // assertion above a boundary rather than a coincidence.
  const past = await audit(
    governs({ name: 'raw.orders', maxAgeMinutes: 60 }, { name: 'mart.daily', maxAgeMinutes: 120 }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'raw.orders', lastRefreshAt: '2026-09-18T07:59:00Z' },
        { name: 'mart.daily', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['raw.orders'] },
      ],
    }),
  )
  assert.deepEqual(ruleIds(past).sort(), ['table-late', 'table-late-upstream'])
})

test('an upstream refreshed exactly at --now is fresh, not an unreadable instant', async () => {
  const report = await audit(
    governs({ name: 'raw.orders', maxAgeMinutes: 60 }, { name: 'mart.daily', maxAgeMinutes: 120 }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'raw.orders', lastRefreshAt: '2026-09-18T09:00:00Z' },
        { name: 'mart.daily', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['raw.orders'] },
      ],
    }),
  )
  assert.deepEqual(ruleIds(report), ['table-late'])
  assert.equal(ruleIds(report).includes('cause-undetermined'), false)

  // One minute later and its age is not a quantity this run can state, so the
  // cause stops being settled.
  const ahead = await audit(
    governs({ name: 'raw.orders', maxAgeMinutes: 60 }, { name: 'mart.daily', maxAgeMinutes: 120 }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'raw.orders', lastRefreshAt: '2026-09-18T09:01:00Z' },
        { name: 'mart.daily', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['raw.orders'] },
      ],
    }),
  )
  assert.equal(ruleIds(ahead).includes('cause-undetermined'), true)
  assert.match(
    findingsFor(ahead, 'cause-undetermined')[0].message,
    /its last refresh is after the instant given to --now/u,
  )
})

test('an upstream the snapshot disagrees with itself about is unknown, never late', async () => {
  // Found by a mutation sweep: deleting the `conflict` arm of the cause
  // classification left the whole suite green, and made the report say
  //
  //   "its upstream chain mart.daily <- raw.orders is late at its far end:
  //    raw.orders is NaN minutes old, above its 60 minute limit"
  //
  // about a table whose last refresh this run could not read at all. The other
  // three unknown arms were each driven by a test; this one was not.
  const conflicted = await audit(
    governs({ name: 'raw.orders', maxAgeMinutes: 60 }, { name: 'mart.daily', maxAgeMinutes: 120 }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'raw.orders', lastRefreshAt: '2026-09-18T08:30:00Z' },
        { name: 'mart.daily', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['raw.orders'] },
      ],
      runs: [{ table: 'raw.orders', runId: 'r-1', state: 'complete', endedAt: '2026-09-18T08:45:00Z' }],
    }),
  )
  assert.deepEqual(
    ruleIds(conflicted).sort(),
    ['cause-undetermined', 'refresh-history-conflict', 'table-late'],
  )
  assert.match(
    findingsFor(conflicted, 'cause-undetermined')[0].message,
    /raw\.orders could not be judged \(the snapshot disagrees with itself about it\)/u,
  )
  // The lateness is still reported, and it is not attributed upstream.
  assert.equal(ruleIds(conflicted).includes('table-late-upstream'), false)
  assert.equal(JSON.stringify(conflicted).includes('NaN'), false)

  // Non-vacuous: the same lineage without the contradiction DOES attribute the
  // cause upstream, so this test is not satisfied by a tool that never does.
  const settled = await audit(
    governs({ name: 'raw.orders', maxAgeMinutes: 60 }, { name: 'mart.daily', maxAgeMinutes: 120 }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'raw.orders', lastRefreshAt: '2026-09-18T01:00:00Z' },
        { name: 'mart.daily', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['raw.orders'] },
      ],
      runs: [{ table: 'raw.orders', runId: 'r-1', state: 'complete', endedAt: '2026-09-18T01:00:00Z' }],
    }),
  )
  assert.equal(ruleIds(settled).includes('table-late-upstream'), true)
  assert.equal(ruleIds(settled).includes('cause-undetermined'), false)
})

test('a governed upstream the snapshot does not hold leaves the cause unsettled', async () => {
  // Distinct from an UNGOVERNED upstream: the policy does declare a deadline
  // for this one, and the snapshot simply has no row to apply it to.
  const report = await audit(
    governs({ name: 'raw.orders', maxAgeMinutes: 60 }, { name: 'mart.daily', maxAgeMinutes: 120 }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [{ name: 'mart.daily', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['raw.orders'] }],
    }),
  )
  assert.deepEqual(
    ruleIds(report).sort(),
    ['cause-undetermined', 'policy-table-absent', 'table-late', 'upstream-unknown'],
  )
  assert.match(
    findingsFor(report, 'cause-undetermined')[0].message,
    /raw\.orders could not be judged \(it is not in the snapshot\)/u,
  )
})

test('the chain does not depend on the order the snapshot lists upstream edges in', async () => {
  // Which table is named as the root cause is this tool's primary output, and
  // it is decided by sorting the upstream names. This test used to use
  // 'a.left' and 'z.right' -- a pair that orders IDENTICALLY under code unit
  // and under ICU collation, so it could not tell the two apart and a collator
  // substituted at that sort changed the blamed table with the suite green.
  //
  // 'Z.raw' and 'a.raw' genuinely disagree: 'Z' (U+005A) precedes 'a' (U+0061)
  // by code unit, while collation sorts by letter first and puts 'a.raw' ahead.
  // Verify by substituting `new Intl.Collator().compare` at the sort in
  // `trace`: this assertion fails and names 'a.raw'.
  const build = (upstream) => snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'mart.daily', lastRefreshAt: '2026-09-18T01:00:00Z', upstream },
      { name: 'Z.raw', lastRefreshAt: '2026-09-18T01:00:00Z' },
      { name: 'a.raw', lastRefreshAt: '2026-09-18T01:00:00Z' },
    ],
  })
  const governed = governs(
    { name: 'mart.daily', maxAgeMinutes: 120 },
    { name: 'Z.raw', maxAgeMinutes: 60 },
    { name: 'a.raw', maxAgeMinutes: 60 },
  )

  const forwards = await audit(governed, build(['Z.raw', 'a.raw']))
  const backwards = await audit(governed, build(['a.raw', 'Z.raw']))
  const chainOf = (report) => findingsFor(report, 'table-late-upstream')
    .find((finding) => finding.message.startsWith('mart.daily')).message

  // The exact chain, not merely a stable one: a tool that blamed the same
  // wrong table in both documents would satisfy the equality alone.
  assert.match(chainOf(forwards), /upstream chain mart\.daily <- Z\.raw is late at its far end: Z\.raw is 480 minutes old/u)
  assert.equal(chainOf(forwards).includes('a.raw'), false)
  assert.equal(chainOf(forwards), chainOf(backwards))

  // The pair the previous version used, kept as the reason it was not enough:
  // both orderings agree here, so an assertion over these two names is
  // satisfied by either sort.
  const collator = new Intl.Collator().compare
  assert.equal(Math.sign(collator('a.left', 'z.right')), Math.sign(byCodeUnit('a.left', 'z.right')))
  assert.notEqual(Math.sign(collator('Z.raw', 'a.raw')), Math.sign(byCodeUnit('Z.raw', 'a.raw')))
})

test('suspensionFor refuses to suspend against a working week that was not declared', () => {
  // The policy validator refuses this combination, so the guard is reachable
  // only through the exported function -- which a library caller can reach.
  const table = { name: 'a.table', suspendOnNonBusinessDays: true, suspendDuringMaintenance: false }
  const calendar = { offsetMinutes: 0, businessDays: null, maintenanceWindows: [] }
  assert.equal(suspensionFor(table, ms('2026-09-19T02:00:00Z'), calendar), null)

  // With a week declared, the same Saturday suspends it.
  const declared = { offsetMinutes: 0, businessDays: new Set(['monday']), maintenanceWindows: [] }
  assert.deepEqual(suspensionFor(table, ms('2026-09-19T02:00:00Z'), declared), {
    kind: 'non-business-day',
    day: 'saturday',
  })
})

test('a tie between two completed runs keeps the first the snapshot lists', async () => {
  const directory = await workspace()
  const snapshotPath = join(directory, 'snapshot.json')
  await writeJson(snapshotPath, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table' }, { name: 'b.table', lastRefreshAt: '2026-09-18T08:00:00Z' }],
    runs: [
      { table: 'a.table', runId: 'first', state: 'complete', endedAt: '2026-09-18T08:00:00Z' },
      { table: 'a.table', runId: 'second', state: 'complete', endedAt: '2026-09-18T08:00:00Z' },
    ],
  }))
  const read = await readSnapshot(snapshotPath, { ...DEFAULT_LIMITS })

  assert.equal(read.latestCompleteRun.get('a.table').runId, 'first')
  assert.equal(refreshOf('a.table', read).source, 'run first')
  // A table that states its own refresh says so, rather than naming a run.
  assert.equal(refreshOf('b.table', read).source, 'lastRefreshAt')
})

test('every finding in one report names the same snapshot file', async () => {
  // Which is why the file term of the sort key can never decide an order here,
  // and why a sweep reports substituting a collator at that term as surviving.
  const report = await audit(
    governs({ name: 'a.table', maxAgeMinutes: 60 }, { name: 'b.absent', maxAgeMinutes: 60 }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z' }],
    }),
  )
  assert.equal(report.findings.length > 1, true)
  assert.deepEqual([...new Set(report.findings.map((finding) => finding.location.file))], ['snapshot.json'])
})
