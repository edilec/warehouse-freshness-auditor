/**
 * Bounded by construction, at a size the documentation calls legal.
 *
 * Measured on this tool before the run index existed: 2048 governed tables in a
 * 2048-deep chain, with 20000 run records, took **21.9 seconds**, because every
 * freshness question rescanned every run and the lineage walk asks that
 * question once per edge per governed table.
 *
 * The README's limits section carries the current figures, measured at both
 * ceiling shapes, with CPU time beside wall time because the machine they were
 * taken on was running dozens of other jobs. The claim they replace -- "the
 * ceiling case finishes in 1.3 seconds under a 512 MB heap" -- was true of the
 * shape it was measured on and false of the shape that maximises the WORK:
 * 21.4 seconds of CPU and 519 MB before the lineage walk was made once-per-node,
 * for a report byte-identical to the 3.6 seconds and 362 MB it takes now.
 *
 * The tests below do not assert a duration, because a wall-clock assertion on a
 * loaded machine reports load rather than complexity. They assert the things
 * that actually keep the bounds: that `readSnapshot` hands back the index with
 * the right content, that a scaled audit still produces the right report, and
 * that the findings bound fires exactly one finding past the limit and stays
 * silent on it. Deleting the index build is caught by the whole suite, because
 * `refreshOf` reads it.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { join } from 'node:path'

import { DEFAULT_LIMITS, MAX_FINDINGS, auditSnapshot, readSnapshot, refreshOf } from '../src/index.mjs'
import { cleanup, ms, policy, project, snapshot, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const NOW = '2026-09-18T09:00:00Z'

test('the run index holds the latest completed run per table, and nothing else', async () => {
  const directory = await workspace()
  const snapshotPath = join(directory, 'snapshot.json')
  await writeJson(snapshotPath, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table' }, { name: 'b.table' }],
    runs: [
      { table: 'a.table', runId: 'early', state: 'complete', endedAt: '2026-09-18T06:00:00Z' },
      { table: 'a.table', runId: 'latest', state: 'complete', endedAt: '2026-09-18T08:00:00Z' },
      { table: 'a.table', runId: 'middle', state: 'complete', endedAt: '2026-09-18T07:00:00Z' },
      { table: 'a.table', runId: 'newer-but-failed', state: 'failed', endedAt: '2026-09-18T08:55:00Z' },
      { table: 'b.table', runId: 'still-going', state: 'running' },
    ],
  }))

  const read = await readSnapshot(snapshotPath, { ...DEFAULT_LIMITS })
  assert.equal(read.ok, true)
  assert.equal(read.latestCompleteRun.get('a.table').runId, 'latest')
  assert.equal(read.latestCompleteRun.has('b.table'), false)

  // And the index is what the freshness question reads.
  assert.equal(refreshOf('a.table', read).ms, ms('2026-09-18T08:00:00Z'))
  assert.equal(refreshOf('b.table', read).kind, 'absent')
})

test('a scaled audit still produces the right report', async () => {
  // 600 governed tables in one chain, with 20000 run records: the shape whose
  // rescan was quadratic. Only the deepest table has no late upstream.
  const size = 600
  const names = Array.from({ length: size }, (unused, index) => `t.${String(index).padStart(4, '0')}`)
  const { policyPath, snapshotPath } = await project(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440, maxLineageDepth: 64 },
      tables: names.map((name) => ({ name, maxAgeMinutes: 60 })),
    }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: names.map((name, index) => ({
        name,
        lastRefreshAt: '2026-09-18T01:00:00Z',
        upstream: index + 1 < size ? [names[index + 1]] : [],
      })),
      runs: Array.from({ length: 20000 }, (unused, index) => ({
        table: names[index % size],
        runId: `r-${index}`,
        state: 'failed',
        endedAt: '2026-09-18T01:00:00Z',
      })),
    }),
  )

  const report = await auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(NOW) })
  assert.equal(report.summary.governed, size)
  assert.equal(report.summary.checked, size)
  assert.equal(report.summary.late, size)

  // The arithmetic, written out so the numbers below are checkable rather than
  // observed: table i has size-1-i edges to the far end. A chain of exactly
  // maxLineageDepth edges is walked, so table i is cut when size-1-i > 64, that
  // is for i < size-65. The 64 tables above that reach the end and name it, and
  // the deepest one has no upstream at all.
  const counts = new Map()
  for (const finding of report.findings) {
    counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1)
  }
  const cut = size - 65
  assert.equal(counts.get('lineage-depth-exceeded'), cut)
  assert.equal(counts.get('table-late-upstream'), 64)
  assert.equal(counts.get('table-late'), cut + 1)
  assert.equal(counts.get('cause-undetermined'), undefined)
  assert.equal(report.status, 'incomplete')
})

test('a lateness whose chain was cut does not advise checking the local job', async () => {
  const names = ['t.0', 't.1', 't.2']
  const { policyPath, snapshotPath } = await project(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440, maxLineageDepth: 1 },
      tables: names.map((name) => ({ name, maxAgeMinutes: 60 })),
    }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: names.map((name, index) => ({
        name,
        lastRefreshAt: '2026-09-18T01:00:00Z',
        upstream: index + 1 < names.length ? [names[index + 1]] : [],
      })),
    }),
  )
  const report = await auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(NOW) })

  const cut = report.findings.find(
    (finding) => finding.ruleId === 'table-late' && finding.message.startsWith('t.0 '),
  )
  assert.match(cut.suggestion, /the far end of its lineage was not reached/u)

  // The deepest table's walk did finish, and only there is the advice sound.
  const local = report.findings.find(
    (finding) => finding.ruleId === 'table-late' && finding.message.startsWith('t.2 '),
  )
  assert.equal(local.suggestion, 'Check the job that refreshes this table.')
})

/**
 * Build a snapshot of `tables` late tables, each naming `edges` upstreams the
 * snapshot does not hold. Each such table yields exactly `edges + 2` findings:
 * one `table-late`, one `upstream-unknown` per absent edge, one
 * `cause-undetermined`.
 */
async function gapSnapshot(counts) {
  const names = counts.map((unused, index) => `t.${String(index).padStart(3, '0')}`)
  return project(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440, maxUpstreamPerTable: 256 },
      tables: names.map((name) => ({ name, maxAgeMinutes: 60 })),
    }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: names.map((name, table) => ({
        name,
        lastRefreshAt: '2026-09-18T01:00:00Z',
        upstream: Array.from({ length: counts[table] }, (unused, edge) => `gap.t${table}u${edge}`),
      })),
    }),
  )
}

test('MAX_FINDINGS: silent at exactly the limit, and says so one finding past it', async () => {
  // `upstream-unknown` is one finding per unreadable lineage edge, and the
  // declared limits allow far more of them than a report can carry: 1280
  // governed tables each naming 256 absent upstreams fits inside the 16 MiB
  // snapshot ceiling and produced 327,680 findings, a 134 MB report and a
  // 1.25 GB peak RSS. The bound is on the WORK, not only on the input.
  const full = Math.floor((MAX_FINDINGS - 2) / 258)
  const remainder = MAX_FINDINGS - full * 258 - 2
  const exact = Array.from({ length: full }, () => 256).concat([remainder])
  assert.equal(exact.reduce((sum, edges) => sum + edges + 2, 0), MAX_FINDINGS)

  const at = await gapSnapshot(exact)
  const atLimit = await auditSnapshot({ policy: at.policyPath, snapshot: at.snapshotPath, now: ms(NOW) })
  assert.equal(atLimit.findings.length, MAX_FINDINGS)
  assert.equal(atLimit.findings.some((finding) => finding.ruleId === 'finding-limit-exceeded'), false)

  // One more edge on the last table is one more finding, and the report says
  // it stopped rather than quietly handing back a shorter list.
  const over = await gapSnapshot(exact.slice(0, -1).concat([remainder + 1]))
  const past = await auditSnapshot({ policy: over.policyPath, snapshot: over.snapshotPath, now: ms(NOW) })
  const limit = past.findings.filter((finding) => finding.ruleId === 'finding-limit-exceeded')
  assert.equal(limit.length, 1)
  assert.equal(limit[0].severity, 'error')
  assert.match(limit[0].message, new RegExp(`reached its limit of ${MAX_FINDINGS} findings and stopped emitting them`, 'u'))
  assert.equal(past.findings.length, MAX_FINDINGS + 1, 'the limit finding is never itself dropped')
  assert.equal(past.status, 'incomplete')

  // The summary still counts what the run actually did, not what it printed.
  assert.equal(past.summary.governed, exact.length)
  assert.equal(past.summary.late, exact.length)
})

test('the assembly does not depend on the argument limit of a spread', () => {
  // `findings.push(...audit.findings)` passes one ARGUMENT per finding, and a
  // legal snapshot reached 327,680 of them: the run ended with "Maximum call
  // stack size exceeded", an EMPTY stdout and exit 2 -- the shape this contract
  // reserves for a configuration error, on an input that was read.
  //
  // Two independent things now stand between that input and that crash.
  // MAX_FINDINGS caps the audit, which the test above pins. And the assembly
  // is a loop, which is what stops the cap's safety margin depending on the
  // stack: where a spread stops working is a property of the BUILD, so it is
  // measured here rather than assumed. On the build these lines were written
  // against it sits between 100000 and 125000 arguments -- above MAX_FINDINGS,
  // and a smaller stack moves it down.
  let spreadLimit = null
  for (const count of [25000, 50000, 100000, 200000, 400000, 800000]) {
    try {
      const sink = []
      sink.push(...new Array(count).fill(0))
    } catch (error) {
      assert.equal(error instanceof RangeError, true, 'the spread fails by exhausting the stack')
      spreadLimit = count
      break
    }
  }
  assert.notEqual(spreadLimit, null, 'a spread of 800000 arguments exceeds any stack this runs on')

  // The loop carries twice whatever that limit turned out to be.
  const collected = []
  for (const value of new Array(spreadLimit * 2).fill(0)) collected.push(value)
  assert.equal(collected.length, spreadLimit * 2)
})
