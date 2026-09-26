/**
 * Guards a mutation sweep would otherwise leave undefended.
 *
 * Several tests here pin a MESSAGE rather than an error class, because two
 * guards in sequence often refuse the same document for different reasons: a
 * suite that only saw a `PolicyError` stayed green when the first guard was
 * deleted, and the report changed without anything noticing.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PolicyError, auditSnapshot, validatePolicy } from '../src/index.mjs'
import {
  cleanup,
  findingsFor,
  ms,
  policy,
  project,
  ruleIds,
  snapshot,
  workspace,
  writeJson,
} from './helpers.mjs'

after(cleanup)

const NOW = '2026-09-18T09:00:00Z'
const TABLE = { name: 'a.table', maxAgeMinutes: 60 }
const POLICY = policy({ limits: { maxSnapshotAgeMinutes: 1440 }, tables: [TABLE] })

function document(overrides = {}) {
  return { schemaVersion: '1', tables: [TABLE], ...overrides }
}

async function auditWith(policyPath, snapshotPath, now = NOW) {
  return auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(now) })
}

const auditDocument = async (snapshotDocument, policyDocument = POLICY) => {
  const { policyPath, snapshotPath } = await project(policyDocument, snapshotDocument)
  return auditWith(policyPath, snapshotPath)
}

test('an instant is required at the library boundary too, not only at the CLI', async () => {
  const { policyPath, snapshotPath } = await project(POLICY, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' }],
  }))
  for (const now of [undefined, null, Number.NaN, 'now', Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now }),
      (error) => error instanceof PolicyError && /never reads a clock of its own/u.test(error.message),
      String(now),
    )
  }
})

test('a snapshot path that does not exist names the code, rather than blaming the read', async () => {
  const directory = await workspace()
  const policyPath = join(directory, 'policy.json')
  await writeJson(policyPath, POLICY)
  const report = await auditWith(policyPath, join(directory, 'absent.json'))
  assert.match(findingsFor(report, 'snapshot-unreadable')[0].message, /could not be inspected \(ENOENT\)\./u)
})

test('a snapshot path naming a directory says so, rather than blaming the read', async () => {
  const directory = await workspace()
  const policyPath = join(directory, 'policy.json')
  await writeJson(policyPath, POLICY)
  const snapshotPath = join(directory, 'snapshot.json')
  await mkdir(snapshotPath)
  const report = await auditWith(policyPath, snapshotPath)
  assert.match(findingsFor(report, 'snapshot-unreadable')[0].message, /does not name a regular file\./u)
})

test('a snapshot that stats but cannot be read is reported as unread', async () => {
  const { policyPath, snapshotPath } = await project(POLICY, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [],
  }))
  await chmod(snapshotPath, 0o000)
  const report = await auditWith(policyPath, snapshotPath)
  await chmod(snapshotPath, 0o644)
  assert.match(findingsFor(report, 'snapshot-unreadable')[0].message, /could not be read \(EACCES\)\./u)
})

test('a snapshot document that is not an object is invalid, not merely mis-versioned', async () => {
  for (const value of [[], 'a string', 7, null]) {
    const report = await auditDocument(value)
    assert.deepEqual(
      ruleIds(report).filter((id) => id.startsWith('snapshot-')),
      ['snapshot-invalid'],
      JSON.stringify(value),
    )
    assert.match(findingsFor(report, 'snapshot-invalid')[0].message, /is not a JSON object\./u)
  }
})

test('a --policy path that does not exist names the code, rather than blaming the read', async () => {
  const directory = await workspace()
  await assert.rejects(
    () => auditWith(join(directory, 'absent.json'), join(directory, 'snapshot.json')),
    (error) => error instanceof PolicyError && /--policy could not be inspected: ENOENT\./u.test(error.message),
  )
})

test('a --policy path naming a directory says so, rather than blaming the read', async () => {
  const directory = await workspace()
  const policyPath = join(directory, 'policy.json')
  await mkdir(policyPath)
  await assert.rejects(
    () => auditWith(policyPath, join(directory, 'snapshot.json')),
    (error) => error instanceof PolicyError && /--policy must name a regular file\./u.test(error.message),
  )
})

test('a --policy file that stats but cannot be read says so, rather than blaming the parse', async () => {
  const { policyPath, snapshotPath } = await project(POLICY, snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [],
  }))
  await chmod(policyPath, 0o000)
  await assert.rejects(
    () => auditWith(policyPath, snapshotPath),
    (error) => error instanceof PolicyError && /--policy could not be read: EACCES\./u.test(error.message),
  )
  await chmod(policyPath, 0o644)
})

test('limits that are not an object are refused rather than silently ignored', () => {
  for (const limits of [[], 'none', 7]) {
    assert.throws(
      () => validatePolicy(document({ limits })),
      /"limits" must be an object\./u,
      JSON.stringify(limits),
    )
  }
})

test('a limit that is not a positive integer is refused rather than disabling the bound', () => {
  for (const value of [0, -1, 1.5, '10', null, Number.NaN]) {
    assert.throws(
      () => validatePolicy(document({ limits: { maxTables: value } })),
      /"limits.maxTables" must be an integer of at least 1\./u,
      JSON.stringify(value),
    )
  }
  assert.equal(validatePolicy(document({ limits: { maxTables: 1 } })).limits.maxTables, 1)
})

test('a suspension flag that is not a boolean is refused rather than coerced', () => {
  for (const value of ['true', 1, null]) {
    assert.throws(
      () => validatePolicy(document({ tables: [{ ...TABLE, suspendDuringMaintenance: value }] })),
      /must be true or false\./u,
      JSON.stringify(value),
    )
  }
  assert.equal(
    validatePolicy(document({ tables: [{ ...TABLE, suspendDuringMaintenance: false }] }))
      .tables[0].suspendDuringMaintenance,
    false,
  )
})

test('a calendar, window list or window entry of the wrong shape is refused', () => {
  assert.throws(() => validatePolicy(document({ calendar: [] })), /"calendar" must be an object\./u)
  assert.throws(
    () => validatePolicy(document({ calendar: { maintenanceWindows: {} } })),
    /"calendar.maintenanceWindows" must be an array\./u,
  )
  assert.throws(
    () => validatePolicy(document({ calendar: { maintenanceWindows: ['w'] } })),
    /must be an object\./u,
  )
  assert.throws(
    () => validatePolicy(document({ calendar: { maintenanceWindows: [{ id: 'w', start: '2026-09-18' }] } })),
    /is missing "end"\./u,
  )
  assert.throws(
    () => validatePolicy(document({
      calendar: {
        maintenanceWindows: [{ id: 'w', start: '2026-09-18', end: '2026-09-19', tables: [] }],
      },
    })),
    /must be a non-empty array, or be left out to mean every table\./u,
  )
})

test('a policy table entry that is not an object is refused', () => {
  assert.throws(() => validatePolicy(document({ tables: ['a.table'] })), /"tables\[0\]" must be an object\./u)
})

test('a snapshot tables or runs field of the wrong shape is refused', async () => {
  const noTables = await auditDocument({ schemaVersion: '1', generatedAt: NOW, tables: {} })
  assert.match(findingsFor(noTables, 'snapshot-invalid')[0].message, /has no "tables" array\./u)

  const badRuns = await auditDocument({ schemaVersion: '1', generatedAt: NOW, tables: [], runs: {} })
  assert.match(findingsFor(badRuns, 'snapshot-invalid')[0].message, /has a "runs" that is not an array\./u)

  const badEntry = await auditDocument({ schemaVersion: '1', generatedAt: NOW, tables: ['a.table'] })
  assert.match(findingsFor(badEntry, 'snapshot-invalid')[0].message, /table entry is not an object\./u)

  const badRun = await auditDocument({ schemaVersion: '1', generatedAt: NOW, tables: [], runs: ['r'] })
  assert.match(findingsFor(badRun, 'snapshot-invalid')[0].message, /run entry is not an object\./u)
})

test('a snapshot table or run key this tool does not read stops the document', async () => {
  const table = await auditDocument({
    schemaVersion: '1',
    generatedAt: NOW,
    tables: [{ name: 'a.table', watermark: '2026-09-18' }],
  })
  assert.match(findingsFor(table, 'snapshot-invalid')[0].message, /unknown key watermark\./u)

  const runEntry = await auditDocument({
    schemaVersion: '1',
    generatedAt: NOW,
    tables: [],
    runs: [{ table: 'a.table', runId: 'r', state: 'failed', attempt: 2 }],
  })
  assert.match(findingsFor(runEntry, 'snapshot-invalid')[0].message, /unknown key attempt\./u)
})

test('a name that renders as nothing is refused in the snapshot as well as the policy', async () => {
  const invisible = String.fromCodePoint(0x200e)
  const table = await auditDocument({ schemaVersion: '1', generatedAt: NOW, tables: [{ name: invisible }] })
  assert.match(findingsFor(table, 'snapshot-invalid')[0].message, /has no usable name\./u)

  const runEntry = await auditDocument({
    schemaVersion: '1',
    generatedAt: NOW,
    tables: [],
    runs: [{ table: invisible, runId: 'r', state: 'failed' }],
  })
  assert.match(findingsFor(runEntry, 'snapshot-invalid')[0].message, /no usable table name or run id\./u)
})

test('an upstream that is not an array, or names nothing usable, is refused', async () => {
  const notArray = await auditDocument({
    schemaVersion: '1',
    generatedAt: NOW,
    tables: [{ name: 'a.table', upstream: 'b.table' }],
  })
  assert.match(findingsFor(notArray, 'snapshot-invalid')[0].message, /an "upstream" that is not an array\./u)

  const unusable = await auditDocument({
    schemaVersion: '1',
    generatedAt: NOW,
    tables: [{ name: 'a.table', upstream: [''] }],
  })
  assert.match(findingsFor(unusable, 'snapshot-invalid')[0].message, /an upstream with no usable name\./u)
})

test('a run endedAt this tool does not read is refused rather than guessed at', async () => {
  const report = await auditDocument({
    schemaVersion: '1',
    generatedAt: NOW,
    tables: [],
    runs: [{ table: 'a.table', runId: 'r-1', state: 'failed', endedAt: 'last night' }],
  })
  assert.deepEqual(findingsFor(report, 'snapshot-invalid')[0].location, {
    file: 'snapshot.json',
    pointer: '/runs/0/endedAt',
  })
})

test('an instant that will not convert to a primitive is a finding, never a crash', async () => {
  // `{"toString": {}}` is JSON, and `String()` of it throws. Every place this
  // tool reads an instant out of a document has to survive that: a snapshot
  // that was READ and could not be understood owes the caller an `incomplete`
  // report naming the field, not an empty stdout with a language error on
  // stderr.
  const unconvertible = { toString: {} }
  const documents = [
    ['a table lastRefreshAt', {
      schemaVersion: '1',
      generatedAt: NOW,
      tables: [{ name: 'a.table', lastRefreshAt: unconvertible }],
    }],
    ['generatedAt', { schemaVersion: '1', generatedAt: unconvertible, tables: [] }],
    ['a run endedAt', {
      schemaVersion: '1',
      generatedAt: NOW,
      tables: [],
      runs: [{ table: 'a.table', runId: 'r-1', state: 'failed', endedAt: unconvertible }],
    }],
    ['a run startedAt', {
      schemaVersion: '1',
      generatedAt: NOW,
      tables: [],
      runs: [{ table: 'a.table', runId: 'r-1', state: 'failed', startedAt: unconvertible }],
    }],
  ]
  for (const [what, document] of documents) {
    const report = await auditDocument(document)
    assert.equal(report.status, 'incomplete', what)
    assert.deepEqual(ruleIds(report), ['snapshot-invalid'], what)
  }

  // The policy side is a CONFIGURATION error, which is the other shape: it
  // throws rather than reporting, and the message describes the value by its
  // shape rather than reproducing it.
  assert.throws(
    () => validatePolicy({
      schemaVersion: '1',
      calendar: { maintenanceWindows: [{ id: 'w', start: unconvertible, end: NOW }] },
      tables: [{ name: 'a.table', maxAgeMinutes: 60, suspendDuringMaintenance: true }],
    }),
    (error) => {
      assert.equal(error instanceof PolicyError, true)
      assert.match(error.message, /must be an instant written as YYYY-MM-DD/u)
      assert.match(error.message, /This document says "\[object\]"/u)
      return true
    },
  )
})

test('a run startedAt this tool does not read is refused rather than accepted in silence', async () => {
  // `startedAt` is in the accepted key set, so a snapshot carrying it is not
  // stopped as an unknown key -- and nothing read or checked it either, so a
  // run record saying `99999` or "not-a-date-at-all" passed through to
  // `status: "pass"` and exit 0. It was the one field that was neither refused
  // as unknown nor checked as known, while the README says a key this tool does
  // not read stops the document.
  for (const value of ['not-a-date-at-all', 99999, '2026-02-30', '2026-09-18T24:00:00Z', true]) {
    const report = await auditDocument({
      schemaVersion: '1',
      generatedAt: NOW,
      tables: [],
      runs: [{ table: 'a.table', runId: 'r-1', state: 'failed', startedAt: value }],
    })
    assert.equal(report.status, 'incomplete', String(value))
    const invalid = findingsFor(report, 'snapshot-invalid')[0]
    assert.equal(invalid.message, 'run r-1 has a startedAt this tool does not read.', String(value))
    assert.deepEqual(invalid.location, { file: 'snapshot.json', pointer: '/runs/0/startedAt' })
  }
})

test('a startedAt this tool does read leaves the run alone, and so does its absence', async () => {
  // The other side of the guard, and the side users notice: a checker that
  // refuses a legal export is worse than one that misses a bad one. Both
  // accepted instant shapes, both explicit empties, and the field left out.
  const documents = [
    { startedAt: '2026-09-18T08:35:00Z' },
    { startedAt: '2026-09-18' },
    { startedAt: null },
    { startedAt: undefined },
    {},
  ]
  for (const extra of documents) {
    const report = await auditDocument({
      schemaVersion: '1',
      generatedAt: NOW,
      tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' }],
      runs: [{ table: 'a.table', runId: 'r-1', state: 'complete', endedAt: '2026-09-18T08:30:00Z', ...extra }],
    })
    assert.deepEqual(report.findings, [], JSON.stringify(extra))
    assert.equal(report.status, 'pass', JSON.stringify(extra))
  }
})

test('one unreadable edge is one finding however many chains pass through it', async () => {
  // Found by a mutation sweep: deleting the dedupe raised `upstream-unknown`
  // three times for the single edge shared.mid -> z.absent, once for each
  // governed table whose lineage walk passes through shared.mid. The existing
  // dedupe test names the same upstream twice in ONE row, which the dedupe
  // catches at a different point, so nothing covered this one.
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'gov.a', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['shared.mid'] },
      { name: 'gov.b', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['shared.mid'] },
      { name: 'shared.mid', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['z.absent'] },
    ],
  }), policy({
    limits: { maxSnapshotAgeMinutes: 1440 },
    tables: ['gov.a', 'gov.b', 'shared.mid'].map((name) => ({ name, maxAgeMinutes: 60 })),
  }))

  const unknown = findingsFor(report, 'upstream-unknown')
  assert.equal(unknown.length, 1)
  assert.match(unknown[0].message, /^shared\.mid names z\.absent as an upstream/u)
  // All three chains still say the cause is unsettled: the edge is reported
  // once, not judged once.
  assert.equal(findingsFor(report, 'cause-undetermined').length, 3)
})

test('an upstream named twice in one row is one edge, not two findings', async () => {
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['z.absent', 'z.absent'] }],
  }))
  assert.equal(findingsFor(report, 'upstream-unknown').length, 1)
})
