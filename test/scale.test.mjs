/**
 * Bounded by construction, at a size the documentation calls legal.
 *
 * Measured on this tool before the run index existed: 2048 governed tables in a
 * 2048-deep chain, with 20000 run records, took **21.9 seconds**, because every
 * freshness question rescanned every run and the lineage walk asks that
 * question once per edge per governed table. The same input now takes 1.4
 * seconds, and the ceiling case -- 20000 tables, 100000 runs, an 11 MB snapshot
 * -- finishes in 1.3 seconds under a 512 MB heap.
 *
 * The tests below do not assert a duration, because a wall-clock assertion on a
 * loaded machine reports load rather than complexity. They assert the two
 * things that actually keep the bound: that `readSnapshot` hands back the index
 * with the right content, and that a scaled audit still produces the right
 * report. Deleting the index build is caught by the whole suite, because
 * `refreshOf` reads it.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { join } from 'node:path'

import { DEFAULT_LIMITS, auditSnapshot, readSnapshot, refreshOf } from '../src/index.mjs'
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
