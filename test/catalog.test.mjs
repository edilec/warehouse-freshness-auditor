/** The catalog, the severity freeze and the identity of the tool. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CATALOG,
  EVIDENCE_MISSING_RULES,
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  TOOL_ID,
  byCodeUnit,
  makeFinding,
  marksEvidenceMissing,
  msg,
  severityFor,
} from '../src/index.mjs'
import { ROOT } from './helpers.mjs'

test('TOOL_ID equals the directory name and the package name', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(TOOL_ID, 'warehouse-freshness-auditor')
  assert.equal(pkg.name, TOOL_ID)
  assert.equal(ROOT.split('/').at(-1), TOOL_ID)
})

test('every rule id has a severity drawn from the declared set', () => {
  for (const id of RULE_IDS) assert.equal(SEVERITIES.includes(severityFor(id)), true, id)
  assert.deepEqual(RULE_IDS, [...Object.keys(RULE_SEVERITY)].sort(byCodeUnit))
})

test('an unknown rule id throws instead of defaulting to something harmless', () => {
  assert.throws(() => severityFor('invented-rule'), /Unknown ruleId/u)
  assert.throws(() => marksEvidenceMissing('invented-rule'), /Unknown ruleId/u)
})

test('a rule id that names a prototype member throws too, and emits no finding', () => {
  // `invented-rule` above is the one class of name that does NOT reach through
  // an object literal. `RULE_SEVERITY['toString']` resolved
  // `Object.prototype.toString`, so severityFor returned a FUNCTION instead of
  // throwing: makeFinding built a finding whose severity was that function,
  // JSON.stringify dropped it -- leaving a finding with no `severity` field,
  // which the report contract makes required -- and statusFor read the run as a
  // pass. The name of the test above claimed this; only its body did not.
  for (const id of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.throws(() => severityFor(id), /Unknown ruleId/u, id)
    assert.throws(() => marksEvidenceMissing(id), /Unknown ruleId/u, id)
    assert.throws(() => makeFinding(id, msg`something`, { file: 'a.json' }), /Unknown ruleId/u, id)
  }

  // A value that cannot be converted to a primitive at all must still produce
  // that error rather than a TypeError from the message describing it.
  assert.throws(() => severityFor({ toString: {} }), /Unknown ruleId "\[object\]"/u)

  // And the positive side, so this test is not satisfied by a severityFor that
  // throws for everything: every real id still answers, and every finding
  // built from one carries a severity that survives JSON.
  for (const id of RULE_IDS) {
    const finding = makeFinding(id, msg`something`, { file: 'a.json' })
    assert.equal(SEVERITIES.includes(JSON.parse(JSON.stringify(finding)).severity), true, id)
  }
})

test('the evidence-missing list is a subset of the catalog, and names the honest ids', () => {
  for (const id of EVIDENCE_MISSING_RULES) assert.equal(RULE_IDS.includes(id), true, id)
  // The five ids deliberately outside it: two lateness verdicts the run DID
  // establish, and three notices that a deadline was not in force.
  assert.deepEqual(RULE_IDS.filter((id) => !EVIDENCE_MISSING_RULES.includes(id)), [
    'no-deadline-in-force',
    'sla-suspended-maintenance',
    'sla-suspended-non-business-day',
    'table-late',
    'table-late-upstream',
  ])
})

test('the exported catalog agrees with the severity table in both directions', () => {
  assert.deepEqual(CATALOG.ruleIds, RULE_IDS)
  assert.deepEqual(CATALOG.evidenceMissing, [...EVIDENCE_MISSING_RULES].sort(byCodeUnit))
  assert.equal(CATALOG.tool, TOOL_ID)
})

test('every rule id is lower-case kebab-case, so the README scan below cannot miss one', () => {
  for (const id of RULE_IDS) assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
})

test('the README documents every rule id, and invents none', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  // The severity column is part of the pattern, so no other table in the README
  // can be mistaken for the rule id catalog.
  const documented = [...readme.matchAll(/^\| `([a-z0-9-]+)` \| (?:error|warning|info) \|/gmu)]
    .map((match) => match[1])
  assert.deepEqual([...documented].sort(byCodeUnit), RULE_IDS)
})
