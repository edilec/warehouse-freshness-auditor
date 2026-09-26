/**
 * Severity as a consumer sees it, over every rule id in the catalog.
 *
 * Flipping `error` to `warning` on a rule that already marks the run incomplete
 * leaves the exit code untouched, so an exit-code test alone does not notice
 * it. The severity still changes what is emitted -- the `severity` field, and
 * the `summary.errors` and `summary.warnings` counts a dashboard adds up.
 *
 * So the expected values here are not copied from the table. Each scenario is
 * driven through the real entry point, the severities are read back OUT of the
 * emitted reports, and they are judged against one stated property: everything
 * this tool reports is an error except the notices that say a deadline was not
 * in force.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MAX_FINDINGS, RULE_IDS, auditSnapshot } from '../src/index.mjs'
import { BUSINESS_DAYS, cleanup, ms, policy, snapshot, workspace, writeJson } from './helpers.mjs'

after(cleanup)

/** The only ids that report something other than a defect or a gap. */
const NOTICES = new Set([
  'no-deadline-in-force',
  'sla-suspended-maintenance',
  'sla-suspended-non-business-day',
])

const LATE = '2026-09-18T01:00:00Z'
const FRESH = '2026-09-18T08:30:00Z'
const GENERATED = '2026-09-18T09:00:00Z'
const NOW = '2026-09-18T09:00:00Z'

const governs = (...names) => policy({
  limits: { maxSnapshotAgeMinutes: 1440 },
  tables: names.map((name) => ({ name, maxAgeMinutes: 60 })),
})

/** Each entry writes a workspace and returns { policy, now }. */
const SCENARIOS = [
  ['table-late', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [{ name: 'a.table', lastRefreshAt: LATE }],
    }))
    return { document: governs('a.table') }
  }],
  ['table-late-upstream', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [
        { name: 'a.table', lastRefreshAt: LATE, upstream: ['b.table'] },
        { name: 'b.table', lastRefreshAt: LATE },
      ],
    }))
    return { document: governs('a.table', 'b.table') }
  }],
  ['cause-undetermined and upstream-unknown', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [{ name: 'a.table', lastRefreshAt: LATE, upstream: ['z.absent'] }],
    }))
    return { document: governs('a.table') }
  }],
  ['lineage-cycle', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [
        { name: 'a.table', lastRefreshAt: LATE, upstream: ['b.table'] },
        { name: 'b.table', lastRefreshAt: LATE, upstream: ['a.table'] },
      ],
    }))
    return { document: governs('a.table', 'b.table') }
  }],
  ['lineage-depth-exceeded', async (root) => {
    const names = ['t.0', 't.1', 't.2']
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: names.map((name, index) => ({
        name,
        lastRefreshAt: LATE,
        upstream: index + 1 < names.length ? [names[index + 1]] : [],
      })),
    }))
    return {
      document: policy({
        limits: { maxSnapshotAgeMinutes: 1440, maxLineageDepth: 1 },
        tables: names.map((name) => ({ name, maxAgeMinutes: 60 })),
      }),
    }
  }],
  ['refresh-history-absent and no-tables-checked', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [{ name: 'a.table' }],
    }))
    return { document: governs('a.table') }
  }],
  ['refresh-history-conflict', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [{ name: 'a.table', lastRefreshAt: FRESH }],
      runs: [{ table: 'a.table', runId: 'r-1', state: 'complete', endedAt: '2026-09-18T08:45:00Z' }],
    }))
    return { document: governs('a.table') }
  }],
  ['refresh-in-future', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T09:30:00Z' }],
    }))
    return { document: governs('a.table') }
  }],
  ['policy-table-absent', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({ generatedAt: GENERATED, tables: [] }))
    return { document: governs('a.table') }
  }],
  ['sla-suspended-non-business-day and no-deadline-in-force', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: '2026-09-19T01:00:00Z',
      tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z' }],
    }))
    return {
      document: policy({
        limits: { maxSnapshotAgeMinutes: 1440 },
        calendar: { businessDays: BUSINESS_DAYS },
        tables: [{ name: 'a.table', maxAgeMinutes: 60, suspendOnNonBusinessDays: true }],
      }),
      now: '2026-09-19T02:00:00Z',
    }
  }],
  ['sla-suspended-maintenance', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: '2026-09-18T00:30:00Z',
      tables: [
        { name: 'a.table', lastRefreshAt: '2026-09-17T20:00:00Z' },
        { name: 'b.table', lastRefreshAt: '2026-09-17T20:00:00Z' },
      ],
    }))
    return {
      document: policy({
        limits: { maxSnapshotAgeMinutes: 1440 },
        calendar: {
          maintenanceWindows: [{ id: 'w', start: '2026-09-18T01:00:00Z', end: '2026-09-18T03:00:00Z' }],
        },
        tables: [
          { name: 'a.table', maxAgeMinutes: 60, suspendDuringMaintenance: true },
          { name: 'b.table', maxAgeMinutes: 60 },
        ],
      }),
      now: '2026-09-18T02:00:00Z',
    }
  }],
  ['snapshot-unreadable', async () => ({ document: governs('a.table') })],
  ['snapshot-not-utf8', async (root) => {
    await writeFile(join(root, 'snapshot.json'), Buffer.from([0x7b, 0xff, 0x7d]))
    return { document: governs('a.table') }
  }],
  ['snapshot-unparsable', async (root) => {
    await writeFile(join(root, 'snapshot.json'), 'not json', 'utf8')
    return { document: governs('a.table') }
  }],
  ['snapshot-invalid', async (root) => {
    await writeJson(join(root, 'snapshot.json'), [])
    return { document: governs('a.table') }
  }],
  ['snapshot-schema-unsupported', async (root) => {
    await writeJson(join(root, 'snapshot.json'), { schemaVersion: '9', generatedAt: GENERATED, tables: [] })
    return { document: governs('a.table') }
  }],
  ['snapshot-stale', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: '2026-09-17T09:00:00Z',
      tables: [{ name: 'a.table', lastRefreshAt: FRESH }],
    }))
    return {
      document: policy({
        limits: { maxSnapshotAgeMinutes: 60 },
        tables: [{ name: 'a.table', maxAgeMinutes: 60 }],
      }),
    }
  }],
  ['snapshot-ahead-of-clock', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: '2026-09-18T10:00:00Z',
      tables: [{ name: 'a.table', lastRefreshAt: FRESH }],
    }))
    return { document: governs('a.table') }
  }],
  ['snapshot-too-large', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [{ name: 'a.table', lastRefreshAt: FRESH }],
    }))
    return {
      document: policy({
        limits: { maxSnapshotAgeMinutes: 1440, maxSnapshotBytes: 1 },
        tables: [{ name: 'a.table', maxAgeMinutes: 60 }],
      }),
    }
  }],
  ['snapshot-too-many-tables', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [{ name: 'a.table', lastRefreshAt: FRESH }, { name: 'b.table', lastRefreshAt: FRESH }],
    }))
    return {
      document: policy({
        limits: { maxSnapshotAgeMinutes: 1440, maxTables: 1 },
        tables: [{ name: 'a.table', maxAgeMinutes: 60 }],
      }),
    }
  }],
  ['snapshot-too-many-runs', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [{ name: 'a.table', lastRefreshAt: FRESH }],
      runs: [
        { table: 'a.table', runId: 'r-1', state: 'failed' },
        { table: 'a.table', runId: 'r-2', state: 'failed' },
      ],
    }))
    return {
      document: policy({
        limits: { maxSnapshotAgeMinutes: 1440, maxRuns: 1 },
        tables: [{ name: 'a.table', maxAgeMinutes: 60 }],
      }),
    }
  }],
  ['finding-limit-exceeded', async (root) => {
    // Enough unreadable lineage edges to pass MAX_FINDINGS: each late table
    // naming 256 upstreams the snapshot does not hold yields 258 findings, so
    // this is one table more than the limit needs, well inside every declared
    // limit. Derived from the constant so it keeps up with a change to it.
    const tableCount = Math.ceil(MAX_FINDINGS / 258) + 1
    const names = Array.from({ length: tableCount }, (unused, index) => `t.${String(index).padStart(4, '0')}`)
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: names.map((name, table) => ({
        name,
        lastRefreshAt: LATE,
        upstream: Array.from({ length: 256 }, (unused, edge) => `gap.t${table}u${edge}`),
      })),
    }))
    return {
      document: policy({
        limits: { maxSnapshotAgeMinutes: 1440, maxUpstreamPerTable: 256 },
        tables: names.map((name) => ({ name, maxAgeMinutes: 60 })),
      }),
    }
  }],
  ['upstream-limit-exceeded', async (root) => {
    await writeJson(join(root, 'snapshot.json'), snapshot({
      generatedAt: GENERATED,
      tables: [{ name: 'a.table', lastRefreshAt: FRESH, upstream: ['x.one', 'x.two'] }],
    }))
    return {
      document: policy({
        limits: { maxSnapshotAgeMinutes: 1440, maxUpstreamPerTable: 1 },
        tables: [{ name: 'a.table', maxAgeMinutes: 60 }],
      }),
    }
  }],
]

test('every rule id is emitted at least once, and at the severity the tool claims', async () => {
  const observed = new Map()
  for (const [label, build] of SCENARIOS) {
    const directory = await workspace()
    const { document, now = NOW } = await build(directory)
    const policyPath = join(directory, 'policy.json')
    await writeJson(policyPath, document)
    const report = await auditSnapshot({
      policy: policyPath,
      snapshot: join(directory, 'snapshot.json'),
      now: ms(now),
    })

    // The counts a consumer adds up must agree with the findings it can see.
    assert.equal(
      report.summary.errors,
      report.findings.filter((finding) => finding.severity === 'error').length,
      label,
    )
    assert.equal(
      report.summary.warnings,
      report.findings.filter((finding) => finding.severity === 'warning').length,
      label,
    )
    for (const finding of report.findings) {
      const previous = observed.get(finding.ruleId)
      assert.equal(previous ?? finding.severity, finding.severity, `${label}: ${finding.ruleId}`)
      observed.set(finding.ruleId, finding.severity)
    }
  }

  // The scenario list must keep up with the catalog. A new rule id with no
  // scenario fails here rather than shipping with no severity ever observed.
  assert.deepEqual([...observed.keys()].sort(), [...RULE_IDS])

  for (const [ruleId, severity] of observed) {
    assert.equal(severity, NOTICES.has(ruleId) ? 'info' : 'error', ruleId)
  }
})
