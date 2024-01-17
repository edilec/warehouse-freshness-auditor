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

const auditDocument = async (snapshotDocument) => {
  const { policyPath, snapshotPath } = await project(POLICY, snapshotDocument)
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

test('a table entry of the wrong shape is refused', () => {
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

test('an upstream named twice in one row is one edge, not two findings', async () => {
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['z.absent', 'z.absent'] }],
  }))
  assert.equal(findingsFor(report, 'upstream-unknown').length, 1)
})
