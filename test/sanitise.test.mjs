/**
 * The sanitisation boundary.
 *
 * Every class below reached output in some shipped tool. The characters are
 * built with `String.fromCodePoint` rather than written into this file, so no
 * editor, transfer or copy-paste can turn an escape into the byte it names --
 * and so this file itself stays free of the things it tests.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import {
  EVIDENCE_LIMIT,
  LINE_SEPARATORS,
  auditSnapshot,
  describeValue,
  isRenderableString,
  makeFinding,
  msg,
  num,
  sanitize,
} from '../src/index.mjs'
import { cleanup, ms, policy, project, snapshot } from './helpers.mjs'

after(cleanup)

const CLASSES = [
  ['C0', 0x0001],
  ['C0 newline', 0x000a],
  ['DEL', 0x007f],
  ['C1 NEL', 0x0085],
  ['C1 CSI', 0x009b],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['bidi LRM', 0x200e],
  ['bidi RLM', 0x200f],
  ['bidi LRE', 0x202a],
  ['bidi RLO', 0x202e],
  ['bidi isolate', 0x2066],
  ['bidi pop isolate', 0x2069],
]

test('every unsafe class is stripped from a value that reaches output', () => {
  for (const [name, code] of CLASSES) {
    assert.equal(sanitize(`a${String.fromCodePoint(code)}b`), 'a b', name)
  }
})

test('LINE_SEPARATORS holds exactly U+2028 and U+2029', () => {
  assert.deepEqual([...LINE_SEPARATORS].map((ch) => ch.codePointAt(0)), [0x2028, 0x2029])
})

test('a string of only unsafe characters renders as nothing, and is not renderable', () => {
  for (const [name, code] of CLASSES) {
    const value = String.fromCodePoint(code).repeat(3)
    assert.equal(sanitize(value), '', name)
    // `trim()` accepts U+0001 and U+200E, which is how a "required and
    // non-empty" field reached output as the empty string in a shipped tool.
    assert.equal(isRenderableString(value), false, name)
  }
})

test('trim and the sanitiser disagree in both directions, which is why the sanitiser decides', () => {
  const bidi = String.fromCodePoint(0x200e)
  assert.equal(bidi.trim().length > 0, true)
  assert.equal(isRenderableString(bidi), false)

  const separator = String.fromCodePoint(0x2028)
  assert.equal(separator.trim().length, 0)
  assert.equal(sanitize(separator), '')
})

test('a table name carries the value through the same boundary as an excerpt', async () => {
  // A shipped tool sanitised its evidence carefully and let a page id
  // containing a newline forge whole lines in the report.
  const name = `mart.orders${String.fromCodePoint(0x000a)}error: forged`
  const { policyPath, snapshotPath } = await project(
    policy({ limits: { maxSnapshotAgeMinutes: 1440 }, tables: [{ name, maxAgeMinutes: 60 }] }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [{ name, lastRefreshAt: '2026-09-18T01:00:00Z' }],
    }),
  )
  const report = await auditSnapshot({
    policy: policyPath,
    snapshot: snapshotPath,
    now: ms('2026-09-18T09:00:00Z'),
  })

  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].ruleId, 'table-late')
  assert.equal(report.findings[0].message.includes(String.fromCodePoint(0x000a)), false)
  assert.match(report.findings[0].message, /^mart\.orders error: forged is 480 minutes old/u)
})

test('a value that cannot be converted to a primitive is described, never thrown over', () => {
  assert.equal(describeValue({ toString: {} }), '[object]')
  assert.equal(sanitize({ toString: {} }), '[object]')
  assert.equal(describeValue(['1']), '[array]')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(undefined), 'undefined')
  // `String(['1'])` is '1', which would read like a value rather than an array.
  assert.notEqual(describeValue(['1']), '1')
})

test('a value longer than the evidence limit is cut, and says it was', () => {
  const cut = sanitize('x'.repeat(EVIDENCE_LIMIT + 50))
  assert.equal(cut.length, EVIDENCE_LIMIT)
  assert.equal(cut.endsWith('...'), true)
  // Exactly at the limit nothing is cut: a bound has two sides here too.
  assert.equal(sanitize('y'.repeat(EVIDENCE_LIMIT)), 'y'.repeat(EVIDENCE_LIMIT))
})

test('a finding message must be built through the checked template', () => {
  assert.throws(
    () => makeFinding('table-late', 'a plain string', {}),
    /must build its message with the msg tagged template/u,
  )
})

test('a literal claiming this tool observed a system or read a clock is refused', () => {
  assert.throws(() => msg`the table was queried for its watermark`, /may not claim/u)
  assert.throws(() => msg`the current time is later than that`, /may not claim/u)
  assert.throws(() => msg`this table did not refresh today`, /may not claim/u)
  // A line break must not hide a forbidden phrase from the check.
  assert.throws(() => msg`the run
      polled the source`, /may not claim/u)
})

test('a table whose own name contains a checked word does not stop the run', () => {
  // The guard scans this tool's own voice, never the input it is describing.
  const built = msg`table ${'ops.live_query_log'} was not read.`
  assert.equal(built.text, 'table ops.live_query_log was not read.')
})

test('num keeps a report free of exponent and negative-zero surprises', () => {
  assert.equal(num(1 / 3), '0.3333')
  assert.equal(num(-0), '0')
  assert.equal(num(Number.NaN), 'NaN')
  assert.equal(num(Number.POSITIVE_INFINITY), 'Infinity')
})
