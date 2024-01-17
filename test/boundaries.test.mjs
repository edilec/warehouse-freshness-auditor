/**
 * Every declared limit, driven from BOTH sides.
 *
 * "Fires at N+1" and "stays silent at exactly N" are two assertions, and across
 * this catalog only the first was ever written. Widening any comparison by one
 * then starts refusing documents sitting exactly on a limit the documentation
 * calls legal, with the whole suite green. Each test below pins both.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  LIMIT_CEILINGS,
  LIMIT_NAMES,
  MAX_AGE_MINUTES,
  MAX_ID_LENGTH,
  MAX_NAMED_UPSTREAMS,
  MAX_OFFSET_MINUTES,
  MAX_POLICY_BYTES,
  MAX_POLICY_TABLES,
  MAX_WINDOWS,
  PolicyError,
  auditSnapshot,
  validatePolicy,
  withinWindow,
} from '../src/index.mjs'
import { cleanup, ms, policy, project, ruleIds, snapshot, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const NOW = '2026-09-18T09:00:00Z'

async function audit(policyDocument, snapshotDocument, now = NOW) {
  const { policyPath, snapshotPath } = await project(policyDocument, snapshotDocument)
  return auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(now) })
}

function onePolicy(overrides = {}) {
  return policy({
    limits: { maxSnapshotAgeMinutes: 1440 },
    tables: [{ name: 'a.table', maxAgeMinutes: 60 }],
    ...overrides,
  })
}

function oneSnapshot(lastRefreshAt) {
  return snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt }],
  })
}

test('a table deadline: silent at exactly maxAgeMinutes, fires one minute past it', async () => {
  const atLimit = await audit(onePolicy(), oneSnapshot('2026-09-18T08:00:00Z'))
  assert.deepEqual(atLimit.findings, [])

  const over = await audit(onePolicy(), oneSnapshot('2026-09-18T07:59:00Z'))
  assert.deepEqual(ruleIds(over), ['table-late'])
})

test('limits.maxSnapshotAgeMinutes: silent at exactly the age, fires one minute past it', async () => {
  const documents = snapshot({
    generatedAt: '2026-09-18T08:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T08:00:00Z' }],
  })

  const atLimit = await audit(
    policy({ limits: { maxSnapshotAgeMinutes: 60 }, tables: [{ name: 'a.table', maxAgeMinutes: 60 }] }),
    documents,
  )
  assert.deepEqual(atLimit.findings, [])

  const over = await audit(
    policy({ limits: { maxSnapshotAgeMinutes: 59 }, tables: [{ name: 'a.table', maxAgeMinutes: 60 }] }),
    documents,
  )
  assert.equal(ruleIds(over).includes('snapshot-stale'), true)
  assert.equal(over.status, 'incomplete')
})

test('a snapshot generated exactly at --now is read, and one minute after it is not', async () => {
  const atNow = await audit(onePolicy(), snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' }],
  }))
  assert.deepEqual(atNow.findings, [])

  const ahead = await audit(onePolicy(), snapshot({
    generatedAt: '2026-09-18T09:01:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' }],
  }))
  assert.equal(ruleIds(ahead).includes('snapshot-ahead-of-clock'), true)
})

test('a refresh exactly at --now is age zero, and one minute after it is not a quantity', async () => {
  const atNow = await audit(onePolicy(), oneSnapshot('2026-09-18T09:00:00Z'))
  assert.deepEqual(atNow.findings, [])

  const ahead = await audit(onePolicy(), oneSnapshot('2026-09-18T09:01:00Z'))
  // The one governed table reached no verdict, so the run also says it
  // established nothing rather than reporting a pass over an empty check.
  assert.deepEqual(ruleIds(ahead), ['no-tables-checked', 'refresh-in-future'])
  assert.equal(ahead.status, 'incomplete')
})

test('limits.maxSnapshotBytes: silent at exactly the file size, fires one byte below it', async () => {
  const { policyPath, snapshotPath, directory } = await project(onePolicy(), oneSnapshot('2026-09-18T08:30:00Z'))
  void directory
  const size = (await stat(snapshotPath)).size

  await writeJson(policyPath, onePolicy({ limits: { maxSnapshotAgeMinutes: 1440, maxSnapshotBytes: size } }))
  const atLimit = await auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(NOW) })
  assert.deepEqual(atLimit.findings, [])

  await writeJson(policyPath, onePolicy({ limits: { maxSnapshotAgeMinutes: 1440, maxSnapshotBytes: size - 1 } }))
  const over = await auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(NOW) })
  assert.equal(ruleIds(over).includes('snapshot-too-large'), true)
})

test('limits.maxTables: silent at exactly the table count, fires one below it', async () => {
  const documents = snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' },
      { name: 'b.table', lastRefreshAt: '2026-09-18T08:30:00Z' },
    ],
  })
  const atLimit = await audit(onePolicy({ limits: { maxSnapshotAgeMinutes: 1440, maxTables: 2 } }), documents)
  assert.deepEqual(atLimit.findings, [])

  const over = await audit(onePolicy({ limits: { maxSnapshotAgeMinutes: 1440, maxTables: 1 } }), documents)
  assert.equal(ruleIds(over).includes('snapshot-too-many-tables'), true)
})

test('limits.maxRuns: silent at exactly the run count, fires one below it', async () => {
  const documents = snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table' }],
    runs: [
      { table: 'a.table', runId: 'r-1', state: 'complete', endedAt: '2026-09-18T08:20:00Z' },
      { table: 'a.table', runId: 'r-2', state: 'complete', endedAt: '2026-09-18T08:30:00Z' },
    ],
  })
  const atLimit = await audit(onePolicy({ limits: { maxSnapshotAgeMinutes: 1440, maxRuns: 2 } }), documents)
  assert.deepEqual(atLimit.findings, [])

  const over = await audit(onePolicy({ limits: { maxSnapshotAgeMinutes: 1440, maxRuns: 1 } }), documents)
  assert.equal(ruleIds(over).includes('snapshot-too-many-runs'), true)
})

test('limits.maxUpstreamPerTable: silent at exactly the count, fires one below it', async () => {
  const documents = snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z', upstream: ['x.one', 'x.two'] }],
  })
  const atLimit = await audit(
    onePolicy({ limits: { maxSnapshotAgeMinutes: 1440, maxUpstreamPerTable: 2 } }),
    documents,
  )
  assert.deepEqual(atLimit.findings, [])

  const over = await audit(
    onePolicy({ limits: { maxSnapshotAgeMinutes: 1440, maxUpstreamPerTable: 1 } }),
    documents,
  )
  assert.equal(ruleIds(over).includes('upstream-limit-exceeded'), true)
})

test('limits.maxLineageDepth: a chain of exactly the limit is walked, one longer is refused', async () => {
  // Four tables, three edges, every one of them late.
  const chain = ['t.0', 't.1', 't.2', 't.3']
  const documents = snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: chain.map((name, index) => ({
      name,
      lastRefreshAt: '2026-09-18T01:00:00Z',
      upstream: index + 1 < chain.length ? [chain[index + 1]] : [],
    })),
  })
  const tables = chain.map((name) => ({ name, maxAgeMinutes: 60 }))

  const atLimit = await audit(policy({ limits: { maxSnapshotAgeMinutes: 1440, maxLineageDepth: 3 }, tables }), documents)
  assert.equal(ruleIds(atLimit).includes('lineage-depth-exceeded'), false)
  assert.equal(atLimit.status, 'fail')

  const over = await audit(policy({ limits: { maxSnapshotAgeMinutes: 1440, maxLineageDepth: 2 }, tables }), documents)
  assert.equal(ruleIds(over).includes('lineage-depth-exceeded'), true)
  assert.equal(over.status, 'incomplete')
})

test('a maintenance window covers its start and not its end', () => {
  const window = { startMs: ms('2026-09-18T01:00:00Z'), endMs: ms('2026-09-18T03:00:00Z') }
  assert.equal(withinWindow(window.startMs - 1, window), false)
  assert.equal(withinWindow(window.startMs, window), true)
  assert.equal(withinWindow(window.endMs - 1, window), true)
  assert.equal(withinWindow(window.endMs, window), false)
})

test('MAX_NAMED_UPSTREAMS: exactly the limit is spelled out, one more is counted', async () => {
  const build = (count) => {
    const upstream = Array.from({ length: count }, (unused, index) => `u.${index}`)
    return snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z', upstream },
        ...upstream.map((name) => ({ name, lastRefreshAt: '2026-09-18T08:30:00Z' })),
      ],
    })
  }
  const named = await audit(
    onePolicy({ limits: { maxSnapshotAgeMinutes: 1440, maxUpstreamPerTable: 16 } }),
    build(MAX_NAMED_UPSTREAMS),
  )
  const message = named.findings.find((finding) => finding.ruleId === 'cause-undetermined').message
  assert.equal(message.includes('and 1 more'), false)
  assert.match(message, /u\.4/u)

  const counted = await audit(
    onePolicy({ limits: { maxSnapshotAgeMinutes: 1440, maxUpstreamPerTable: 16 } }),
    build(MAX_NAMED_UPSTREAMS + 1),
  )
  const longer = counted.findings.find((finding) => finding.ruleId === 'cause-undetermined').message
  assert.match(longer, /and 1 more/u)
})

test('MAX_POLICY_TABLES: exactly the maximum validates, one more is refused', () => {
  const make = (count) => ({
    schemaVersion: '1',
    tables: Array.from({ length: count }, (unused, index) => ({ name: `t.${index}`, maxAgeMinutes: 60 })),
  })
  assert.equal(validatePolicy(make(MAX_POLICY_TABLES)).tables.length, MAX_POLICY_TABLES)
  assert.throws(() => validatePolicy(make(MAX_POLICY_TABLES + 1)), PolicyError)
})

test('MAX_WINDOWS: exactly the maximum validates, one more is refused', () => {
  const make = (count) => ({
    schemaVersion: '1',
    tables: [{ name: 'a.table', maxAgeMinutes: 60 }],
    calendar: {
      maintenanceWindows: Array.from({ length: count }, (unused, index) => ({
        id: `w-${index}`,
        start: '2026-09-18T01:00:00Z',
        end: '2026-09-18T02:00:00Z',
      })),
    },
  })
  assert.equal(validatePolicy(make(MAX_WINDOWS)).calendar.maintenanceWindows.length, MAX_WINDOWS)
  assert.throws(() => validatePolicy(make(MAX_WINDOWS + 1)), PolicyError)
})

test('MAX_AGE_MINUTES: exactly the maximum validates, one more is refused', () => {
  const make = (value) => ({ schemaVersion: '1', tables: [{ name: 'a.table', maxAgeMinutes: value }] })
  assert.equal(validatePolicy(make(MAX_AGE_MINUTES)).tables[0].maxAgeMinutes, MAX_AGE_MINUTES)
  assert.throws(() => validatePolicy(make(MAX_AGE_MINUTES + 1)), PolicyError)
  assert.equal(validatePolicy(make(1)).tables[0].maxAgeMinutes, 1)
  assert.throws(() => validatePolicy(make(0)), PolicyError)
})

test('MAX_OFFSET_MINUTES: exactly the maximum validates on both signs, one more is refused', () => {
  const make = (value) => ({
    schemaVersion: '1',
    tables: [{ name: 'a.table', maxAgeMinutes: 60 }],
    calendar: { offsetMinutes: value },
  })
  for (const sign of [1, -1]) {
    assert.equal(validatePolicy(make(sign * MAX_OFFSET_MINUTES)).calendar.offsetMinutes, sign * MAX_OFFSET_MINUTES)
    assert.throws(() => validatePolicy(make(sign * (MAX_OFFSET_MINUTES + 1))), PolicyError)
  }
})

test('MAX_ID_LENGTH: a name of exactly the maximum validates, one longer is refused', () => {
  const make = (length) => ({ schemaVersion: '1', tables: [{ name: 'n'.repeat(length), maxAgeMinutes: 60 }] })
  assert.equal(validatePolicy(make(MAX_ID_LENGTH)).tables[0].name.length, MAX_ID_LENGTH)
  assert.throws(() => validatePolicy(make(MAX_ID_LENGTH + 1)), PolicyError)
})

test('every configurable limit accepts its ceiling and refuses one above it', () => {
  const base = { schemaVersion: '1', tables: [{ name: 'a.table', maxAgeMinutes: 60 }] }
  for (const name of LIMIT_NAMES) {
    const ceiling = LIMIT_CEILINGS[name]
    assert.equal(
      validatePolicy({ ...base, limits: { [name]: ceiling } }).limits[name],
      ceiling,
      `${name} should accept its ceiling`,
    )
    assert.throws(
      () => validatePolicy({ ...base, limits: { [name]: ceiling + 1 } }),
      PolicyError,
      `${name} should refuse one above its ceiling`,
    )
  }
})

test('MAX_POLICY_BYTES: a file of exactly the limit is read, one byte more is refused', async () => {
  const directory = await workspace()
  const snapshotPath = join(directory, 'snapshot.json')
  await writeJson(snapshotPath, oneSnapshot('2026-09-18T08:30:00Z'))

  // JSON permits trailing whitespace, so the document is padded to an exact
  // byte count without changing what it says.
  const body = JSON.stringify(onePolicy())
  const pad = (size) => body + ' '.repeat(size - Buffer.byteLength(body))

  const atLimit = join(directory, 'at-limit.json')
  await writeFile(atLimit, pad(MAX_POLICY_BYTES), 'utf8')
  assert.equal((await stat(atLimit)).size, MAX_POLICY_BYTES)
  const ok = await auditSnapshot({ policy: atLimit, snapshot: snapshotPath, now: ms(NOW) })
  assert.deepEqual(ok.findings, [])

  const over = join(directory, 'over-limit.json')
  await writeFile(over, pad(MAX_POLICY_BYTES + 1), 'utf8')
  await assert.rejects(
    () => auditSnapshot({ policy: over, snapshot: snapshotPath, now: ms(NOW) }),
    (error) => error instanceof PolicyError && /was not opened/u.test(error.message),
  )
})
