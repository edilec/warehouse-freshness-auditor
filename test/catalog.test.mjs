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
  marksEvidenceMissing,
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
