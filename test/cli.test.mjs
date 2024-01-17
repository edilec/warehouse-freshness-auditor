/**
 * The two shapes of exit 2, the required clock, and the streams a consumer
 * pipes.
 *
 * A configuration error means the run never had a subject, so stdout stays
 * EMPTY. Evidence that could not be read means the run had a subject and failed
 * to obtain facts about it, so stdout carries an `incomplete` report naming
 * which input was not read.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BIN, cleanup, policy, project, run, snapshot, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const POLICY = policy({
  limits: { maxSnapshotAgeMinutes: 1440 },
  tables: [{ name: 'a.table', maxAgeMinutes: 60 }],
})

const fresh = () => snapshot({
  generatedAt: '2026-09-18T09:00:00Z',
  tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' }],
})

const stale = () => snapshot({
  generatedAt: '2026-09-18T09:00:00Z',
  tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z' }],
})

const args = ({ policyPath, snapshotPath }, extra = []) => [
  '--policy', policyPath, '--snapshot', snapshotPath, '--now', '2026-09-18T09:00:00Z', ...extra,
]

test('--help writes usage to stderr, leaves stdout empty and exits 0', async () => {
  const result = await run(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /warehouse-freshness-auditor/u)
  assert.match(result.stderr, /Absent history is unknown\./u)
  assert.match(result.stderr, /There is no default for it/u)
})

test('--now is required, and its absence keeps stdout empty', async () => {
  const project_ = await project(POLICY, fresh())
  const result = await run(['--policy', project_.policyPath, '--snapshot', project_.snapshotPath])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--now is required: this tool never reads a clock of its own/u)
})

test('an instant this tool does not read is refused rather than passed to a lenient parser', async () => {
  const project_ = await project(POLICY, fresh())
  for (const now of ['2026-09-18T09:00:00', 'yesterday', '18/09/2026']) {
    const result = await run([
      '--policy', project_.policyPath, '--snapshot', project_.snapshotPath, '--now', now,
    ])
    assert.equal(result.code, 2, now)
    assert.equal(result.stdout, '', now)
    assert.match(result.stderr, /--now requires YYYY-MM-DD/u)
  }
})

test('the verdict follows the instant it is given, not the machine it runs on', async () => {
  // The same two documents, two instants, two different answers. A tool that
  // read a clock could not produce both.
  const project_ = await project(POLICY, fresh())
  const early = await run([
    '--policy', project_.policyPath, '--snapshot', project_.snapshotPath,
    '--now', '2026-09-18T09:00:00Z', '--json',
  ])
  assert.equal(early.code, 0)
  assert.equal(JSON.parse(early.stdout).status, 'pass')

  const later = await run([
    '--policy', project_.policyPath, '--snapshot', project_.snapshotPath,
    '--now', '2026-09-18T09:31:00Z', '--json',
  ])
  assert.equal(later.code, 1)
  assert.equal(JSON.parse(later.stdout).findings[0].ruleId, 'table-late')
})

test('the same arguments twice produce byte-identical stdout', async () => {
  const project_ = await project(POLICY, stale())
  const first = await run(args(project_, ['--json']))
  const second = await run(args(project_, ['--json']))
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
})

test('an unknown option keeps stdout empty and exits 2', async () => {
  const result = await run(['--policy', 'x', '--snapshot', 'y', '--now', '2026-09-18', '--invented'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--invented"/u)
})

test('a missing required option keeps stdout empty and exits 2', async () => {
  for (const argv of [[], ['--policy', 'x'], ['--snapshot', 'y']]) {
    const result = await run(argv)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /is required/u)
  }
})

test('an invalid policy keeps stdout empty and exits 2', async () => {
  const directory = await workspace()
  const policyPath = join(directory, 'policy.json')
  await writeJson(policyPath, { schemaVersion: '2', tables: [] })
  const result = await run(['--policy', policyPath, '--snapshot', 'x', '--now', '2026-09-18'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /"schemaVersion" must be "1"/u)
})

test('an unreadable snapshot emits an incomplete report on stdout and exits 2', async () => {
  const directory = await workspace()
  const policyPath = join(directory, 'policy.json')
  await writeJson(policyPath, POLICY)
  const result = await run([
    '--policy', policyPath, '--snapshot', join(directory, 'absent.json'), '--now', '2026-09-18', '--json',
  ])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'snapshot-unreadable')
  assert.equal(result.stderr, '')
})

test('a clean run exits 0 with a parseable report and a human summary', async () => {
  const project_ = await project(POLICY, fresh())
  const result = await run(args(project_))
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.findings, [])
  assert.equal(report.tool, 'warehouse-freshness-auditor')
  assert.equal(report.schemaVersion, '1')
  assert.match(result.stderr, /warehouse-freshness-auditor: pass/u)
})

test('a late table exits 1', async () => {
  const result = await run(args(await project(POLICY, stale()), ['--json']))
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout).status, 'fail')
})

test('--json suppresses the summary but never the report', async () => {
  const result = await run(args(await project(POLICY, fresh()), ['--json']))
  assert.equal(result.stderr, '')
  assert.notEqual(result.stdout, '')
})

test('the human summary says plainly that incomplete is not a pass', async () => {
  const project_ = await project(POLICY, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table' }],
  }))
  const result = await run(args(project_))
  assert.equal(result.code, 2)
  assert.match(
    result.stderr,
    /incomplete: at least one table was not established as fresh or late\. This is not a pass\./u,
  )
})

test('stdout is only ever the report, so it pipes into a parser', async () => {
  const result = await run(args(await project(POLICY, stale())))
  assert.doesNotThrow(() => JSON.parse(result.stdout))
  assert.equal(result.stdout.endsWith('}\n'), true)
})

test('the CLI writes no file of its own', async () => {
  const project_ = await project(POLICY, fresh())
  const before = (await readdir(project_.directory)).sort()
  await run(args(project_, ['--json']))
  assert.deepEqual((await readdir(project_.directory)).sort(), before)
})

test('a policy that is not valid UTF-8 is a configuration error with empty stdout', async () => {
  const directory = await workspace()
  const policyPath = join(directory, 'policy.json')
  await writeFile(policyPath, Buffer.from([0x7b, 0xff, 0x7d]))
  const result = await run(['--policy', policyPath, '--snapshot', 'x', '--now', '2026-09-18'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--policy is not valid UTF-8\./u)
})

test('the bin path is the documented entry point', () => {
  assert.equal(BIN.endsWith('/bin/warehouse-freshness-auditor.mjs'), true)
})
