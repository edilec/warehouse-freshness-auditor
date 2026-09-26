/**
 * Severity, pinned BEHAVIOURALLY.
 *
 * A severity table asserted against a hand-written expected map in the tests is
 * three declarations agreeing with each other, and a coordinated edit of all
 * three passes. An exit code cannot be edited at all, so the rules below are
 * driven through the real entry point and judged by what the process does.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import {
  EVIDENCE_MISSING_RULES,
  RULE_IDS,
  auditSnapshot,
  exitCodeFor,
  severityFor,
  statusFor,
} from '../src/index.mjs'
import { BUSINESS_DAYS, cleanup, ms, policy, project, ruleIds, snapshot } from './helpers.mjs'

after(cleanup)

async function audit(policyDocument, snapshotDocument, now = '2026-09-18T09:00:00Z') {
  const { policyPath, snapshotPath } = await project(policyDocument, snapshotDocument)
  return auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(now) })
}

const GOVERNED = policy({
  limits: { maxSnapshotAgeMinutes: 1440 },
  tables: [{ name: 'a.table', maxAgeMinutes: 60 }, { name: 'b.table', maxAgeMinutes: 60 }],
})

test('a late table makes the run fail and exit 1', async () => {
  const report = await audit(GOVERNED, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z' },
      { name: 'b.table', lastRefreshAt: '2026-09-18T08:30:00Z' },
    ],
  }))
  assert.deepEqual(ruleIds(report), ['table-late'])
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('missing evidence outranks a lateness verdict and exits 2', async () => {
  // Both findings are present: one table is definitely late, another was never
  // established. The run must not settle for "fail" -- that would report a
  // partial audit as a complete one.
  const report = await audit(GOVERNED, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z' }, { name: 'b.table' }],
  }))
  assert.deepEqual(ruleIds(report).sort(), ['refresh-history-absent', 'table-late'])
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('an info finding on its own never changes the exit code', async () => {
  const report = await audit(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440 },
      calendar: { businessDays: BUSINESS_DAYS },
      tables: [
        { name: 'a.table', maxAgeMinutes: 60, suspendOnNonBusinessDays: true },
        { name: 'b.table', maxAgeMinutes: 60 },
      ],
    }),
    snapshot({
      generatedAt: '2026-09-19T01:00:00Z',
      tables: [
        { name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z' },
        { name: 'b.table', lastRefreshAt: '2026-09-19T01:30:00Z' },
      ],
    }),
    '2026-09-19T02:00:00Z',
  )
  assert.deepEqual(ruleIds(report), ['sla-suspended-non-business-day'])
  assert.equal(severityFor('sla-suspended-non-business-day'), 'info')
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
})

test('exit 0 is reachable only with no error-severity finding at all', async () => {
  const report = await audit(GOVERNED, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' },
      { name: 'b.table', lastRefreshAt: '2026-09-18T08:30:00Z' },
    ],
  }))
  assert.deepEqual(report.findings, [])
  assert.equal(exitCodeFor(report), 0)
})

test('every evidence-missing id would exit 2 if it were the only finding', () => {
  for (const id of EVIDENCE_MISSING_RULES) {
    const findings = [{ ruleId: id, severity: severityFor(id), message: '', location: {} }]
    const report = { status: statusFor(findings), findings }
    assert.equal(report.status, 'incomplete', id)
    assert.equal(exitCodeFor(report), 2, id)
  }
})

test('every id outside that list gives fail or pass, never incomplete', () => {
  for (const id of RULE_IDS.filter((candidate) => !EVIDENCE_MISSING_RULES.includes(candidate))) {
    const findings = [{ ruleId: id, severity: severityFor(id), message: '', location: {} }]
    const report = { status: statusFor(findings), findings }
    assert.notEqual(report.status, 'incomplete', id)
    assert.equal(exitCodeFor(report), severityFor(id) === 'error' ? 1 : 0, id)
  }
})
