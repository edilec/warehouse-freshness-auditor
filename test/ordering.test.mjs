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

import { RULE_IDS, UNKNOWN_REASONS, auditSnapshot, byCodeUnit, renderReport } from '../src/index.mjs'
import { cleanup, findingsFor, ms, policy, project, snapshot } from './helpers.mjs'

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

test('the upstream names in an undetermined cause are ordered by code unit', async () => {
  // The names come from the snapshot, so they can be anything, and this order
  // is emitted text: substituting a collator at the sort in `cause-undetermined`
  // reorders the list with the rest of the suite green. 'Z.x' precedes 'a.x' by
  // code unit (U+005A before U+0061) and follows it under collation, so this
  // assertion distinguishes the two orderings rather than agreeing with both.
  const document = (upstream) => snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'mart.daily', lastRefreshAt: '2026-09-18T01:00:00Z', upstream },
      { name: 'Z.x', lastRefreshAt: '2026-09-18T01:00:00Z' },
      { name: 'a.x', lastRefreshAt: '2026-09-18T01:00:00Z' },
      { name: 'b.gap' },
    ],
  })
  const governed = policy({
    limits: { maxSnapshotAgeMinutes: 1440 },
    tables: [{ name: 'mart.daily', maxAgeMinutes: 120 }, { name: 'b.gap', maxAgeMinutes: 60 }],
  })

  const forwards = await audit(governed, document(['a.x', 'Z.x', 'b.gap']))
  const backwards = await audit(governed, document(['b.gap', 'Z.x', 'a.x']))
  const causeOf = (report) => findingsFor(report, 'cause-undetermined')[0].message

  assert.match(causeOf(forwards), /why is not settled: Z\.x, a\.x, b\.gap could not be judged/u)
  assert.equal(causeOf(forwards), causeOf(backwards))

  // And the reasons beside them, in the one order this set can take. This
  // assertion CANNOT tell a collator from code unit -- the proof that it does
  // not need to is the closed-set test below, which is the honest division of
  // labour rather than a second assertion that would agree with both.
  assert.match(
    causeOf(forwards),
    /\(the policy declares no maxAgeMinutes for it; the snapshot holds no refresh history for it\)/u,
  )
})

test('the reasons an upstream cannot be judged sort the same either way, which is why a collator there is equivalent', () => {
  // A mutation sweep reports substituting a collator at the REASON sort as
  // surviving. Naming that an equivalent mutant is a claim, so it is checked:
  // over the closed set of reasons this tool can produce, code-unit order and
  // ICU collation are the same permutation, and every subset of a set with that
  // property has it too. A sixth reason that broke it fails here instead of
  // making the emitted message depend on the Node build's ICU data.
  const reasons = Object.values(UNKNOWN_REASONS)
  assert.equal(reasons.length, 5)
  assert.equal(new Set(reasons).size, 5)
  const collator = new Intl.Collator()
  assert.deepEqual([...reasons].sort(byCodeUnit), [...reasons].sort(collator.compare))

  // Non-vacuous: the same comparison over names a snapshot may legally use
  // disagrees, so this assertion is a property of THIS set and not of the two
  // orderings in general.
  assert.notDeepEqual(
    ['Z.x', 'a.x'].sort(byCodeUnit),
    ['Z.x', 'a.x'].sort(collator.compare),
  )
})
