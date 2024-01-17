/**
 * Ordering, pinned BEHAVIOURALLY.
 *
 * A source scan for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text. So the inputs below are chosen because the two orders genuinely
 * disagree, and the assertion is the exact emitted order.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { RULE_IDS, auditSnapshot, renderReport } from '../src/index.mjs'
import { cleanup, ms, policy, project, snapshot } from './helpers.mjs'

after(cleanup)

const NOW = '2026-09-18T09:00:00Z'

async function audit(policyDocument, snapshotDocument) {
  const { policyPath, snapshotPath } = await project(policyDocument, snapshotDocument)
  return auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(NOW) })
}

test('findings are emitted in code-unit order of their pointer', async () => {
  // Pointers this tool emits are indexes, so '/tables/10' precedes '/tables/9'.
  // A NUMERIC collator disagrees, which is the drift this pins against; the
  // default collator agrees, and the property test below says so rather than
  // leaving the reader to assume a stronger guarantee than the input gives.
  const numeric = new Intl.Collator(undefined, { numeric: true })
  assert.equal(numeric.compare('/tables/10', '/tables/9') > 0, true)

  const names = Array.from({ length: 11 }, (unused, index) => `t.${index}`)
  const report = await audit(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440 },
      tables: names.map((name) => ({ name, maxAgeMinutes: 60 })),
    }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: names.map((name) => ({ name, lastRefreshAt: '2026-09-18T01:00:00Z' })),
    }),
  )

  const pointers = report.findings.map((finding) => finding.location.pointer)
  assert.equal(pointers.length, 11)
  assert.deepEqual(pointers.slice(0, 3), ['/tables/0', '/tables/1', '/tables/10'])
  assert.equal(pointers.indexOf('/tables/10') < pointers.indexOf('/tables/9'), true)
})

test('findings sharing a pointer sort by rule id in code-unit order', async () => {
  // 'table-late' and 'upstream-unknown' land on the same table row, and code
  // unit puts the shorter-prefixed id first.
  const report = await audit(
    policy({ limits: { maxSnapshotAgeMinutes: 1440 }, tables: [{ name: 'a.table', maxAgeMinutes: 60 }] }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['z.absent'] }],
    }),
  )
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['cause-undetermined', 'table-late', 'upstream-unknown'],
  )
  assert.deepEqual(
    [...new Set(report.findings.map((finding) => finding.location.pointer))],
    ['/tables/0'],
  )
})

test('the rule-id and pointer terms are equivalent mutants today, and this proves it', () => {
  // A mutation sweep reports substituting a collator at those two terms as
  // SURVIVING. Both are equivalent mutants rather than missing tests: over the
  // rule ids THIS catalog holds, and over the pointers this tool can emit, code
  // unit order and default ICU collation are the same permutation, so no input
  // can tell them apart. Both are properties of today's strings rather than
  // guarantees, and these assertions fail the moment a new rule id or a new
  // pointer shape breaks one -- which is the signal that the term now needs a
  // behavioural pin of its own.
  //
  // The `location.file` term is a third such case, for a different reason: a
  // report describes one snapshot, so every finding in it carries the same
  // file and that term never decides anything. The term stays because the
  // documented sort key names it.
  const collator = new Intl.Collator()
  const agree = (values, what) => {
    for (const a of values) {
      for (const b of values) {
        if (a === b) continue
        assert.equal(Math.sign(collator.compare(a, b)), a < b ? -1 : 1, `${what}: ${a} vs ${b}`)
      }
    }
  }
  agree(RULE_IDS, 'rule ids')

  const pointers = ['/generatedAt', '/tables', '/runs']
  for (let index = 0; index < 40; index += 1) {
    pointers.push(`/tables/${index}`, `/tables/${index}/lastRefreshAt`)
    pointers.push(`/runs/${index}`, `/runs/${index}/endedAt`)
  }
  agree(pointers, 'pointers')
})

test('findings sharing a pointer and a rule id sort by message in code-unit order', async () => {
  // Two upstream tables the snapshot does not hold, both reported against the
  // same row with the same rule id. Table names are the author's own strings,
  // so they can be chosen where code unit and collation disagree.
  const collator = new Intl.Collator()
  assert.equal(collator.compare('Z.missing', 'a.missing') > 0, true)

  const report = await audit(
    policy({ limits: { maxSnapshotAgeMinutes: 1440 }, tables: [{ name: 'a.table', maxAgeMinutes: 60 }] }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [{
        name: 'a.table',
        lastRefreshAt: '2026-09-18T01:00:00Z',
        upstream: ['a.missing', 'Z.missing'],
      }],
    }),
  )

  const unknown = report.findings.filter((finding) => finding.ruleId === 'upstream-unknown')
  assert.equal(unknown.length, 2)
  assert.deepEqual(
    unknown.map((finding) => finding.message.match(/names (\S+) as an upstream/u)[1]),
    ['Z.missing', 'a.missing'],
  )
})

test('two runs over identical inputs produce byte-identical stdout', async () => {
  const documents = [
    policy({ limits: { maxSnapshotAgeMinutes: 1440 }, tables: [{ name: 'a.table', maxAgeMinutes: 60 }] }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z' }],
    }),
  ]
  const first = renderReport(await audit(...documents))
  const second = renderReport(await audit(...documents))
  assert.equal(first, second)
  assert.equal(first.includes('"ruleId"'), true)
})
