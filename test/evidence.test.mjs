/**
 * Evidence about the snapshot: everything that makes a run incomplete rather
 * than clean, and the allowed cases that must stay silent beside each refusal.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { auditSnapshot } from '../src/index.mjs'
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
const POLICY = policy({
  limits: { maxSnapshotAgeMinutes: 1440 },
  tables: [{ name: 'a.table', maxAgeMinutes: 60 }],
})

async function auditRaw(write) {
  const directory = await workspace()
  const policyPath = join(directory, 'policy.json')
  const snapshotPath = join(directory, 'snapshot.json')
  await writeJson(policyPath, POLICY)
  await write(snapshotPath)
  return auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(NOW) })
}

const auditDocument = (document) => auditRaw((path) => writeJson(path, document))

test('a snapshot that is not valid UTF-8 is not decoded, and is not a pass', async () => {
  const report = await auditRaw((path) => writeFile(path, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d])))
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['snapshot-not-utf8'])
})

test('a document holding a literal replacement character still decodes and is audited', async () => {
  // Encoding validity is never inferred from decoded content. A tool in this
  // catalog disabled its own encoding guard file-wide because a document
  // legitimately contained U+FFFD.
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' }],
    runs: [{
      table: 'a.table',
      runId: `run-${String.fromCodePoint(0xfffd)}`,
      state: 'failed',
      endedAt: '2026-09-18T08:00:00Z',
    }],
  }))
  assert.deepEqual(report.findings, [])
})

test('a snapshot declaring an unsupported schema version is refused', async () => {
  const report = await auditDocument({ schemaVersion: '9', generatedAt: '2026-09-18T09:00:00Z', tables: [] })
  assert.equal(report.status, 'incomplete')
  assert.match(
    findingsFor(report, 'snapshot-schema-unsupported')[0].message,
    /declares schemaVersion 9; this tool reads 1/u,
  )
})

test('a snapshot with no readable generatedAt is refused rather than dated by this tool', async () => {
  for (const generatedAt of [undefined, null, '18/09/2026', '2026-09-18T09:00:00']) {
    const report = await auditDocument({ schemaVersion: '1', generatedAt, tables: [] })
    assert.equal(report.status, 'incomplete', String(generatedAt))
    assert.deepEqual(findingsFor(report, 'snapshot-invalid')[0].location, {
      file: 'snapshot.json',
      pointer: '/generatedAt',
    })
  }
})

test('a snapshot key this tool does not read stops the document rather than being ignored', async () => {
  // A key it does not read may carry the evidence it would have used, so the
  // document is not treated as understood.
  const report = await auditDocument({
    schemaVersion: '1',
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [],
    lineage: [{ from: 'a', to: 'b' }],
  })
  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'snapshot-invalid')[0].message, /unknown key lineage/u)
})

test('a table named twice is refused, because which row describes it is not settled', async () => {
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' },
      { name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z' },
    ],
  }))
  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'snapshot-invalid')[0].message, /names table a\.table twice/u)
})

test('a lastRefreshAt this tool does not read is refused rather than guessed at', async () => {
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '18 September 2026' }],
  }))
  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'snapshot-invalid')[0].message, /It was not guessed at\./u)
})

test('a completed run with no endedAt cannot establish a refresh, and says so', async () => {
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table' }],
    runs: [{ table: 'a.table', runId: 'run-1', state: 'complete' }],
  }))
  assert.equal(report.status, 'incomplete')
  assert.match(
    findingsFor(report, 'snapshot-invalid')[0].message,
    /recorded as complete but does not say when it ended/u,
  )
})

test('a run state this tool does not read is refused by naming the ones it does', async () => {
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table' }],
    runs: [{ table: 'a.table', runId: 'run-1', state: 'succeeded', endedAt: '2026-09-18T08:30:00Z' }],
  }))
  assert.match(
    findingsFor(report, 'snapshot-invalid')[0].message,
    /the states this tool reads are aborted, complete, failed, running/u,
  )
})

test('a snapshot that disagrees with itself picks no winner', async () => {
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' }],
    runs: [{ table: 'a.table', runId: 'run-9', state: 'complete', endedAt: '2026-09-18T08:45:00Z' }],
  }))
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('table-late'), false)
  assert.match(
    findingsFor(report, 'refresh-history-conflict')[0].message,
    /Neither value was chosen and no age was computed\./u,
  )
})

test('a completed run that ended before lastRefreshAt is ordinary history, not a conflict', async () => {
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [{ name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' }],
    runs: [{ table: 'a.table', runId: 'run-9', state: 'complete', endedAt: '2026-09-18T07:45:00Z' }],
  }))
  assert.deepEqual(report.findings, [])
})

test('a table the policy governs and the snapshot does not hold is unknown', async () => {
  const report = await auditDocument(snapshot({ generatedAt: '2026-09-18T09:00:00Z', tables: [] }))
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report).sort(), ['no-tables-checked', 'policy-table-absent'])
  assert.match(
    findingsFor(report, 'policy-table-absent')[0].message,
    /the snapshot holds no row for it, so whether it refreshed within 60 minutes was not established/u,
  )
})

test('a snapshot table the policy does not govern is simply not governed', async () => {
  // Reporting an ungoverned table would be a finding on correct input: the
  // policy is what decides which tables have deadlines.
  const report = await auditDocument(snapshot({
    generatedAt: '2026-09-18T09:00:00Z',
    tables: [
      { name: 'a.table', lastRefreshAt: '2026-09-18T08:30:00Z' },
      { name: 'z.ungoverned', lastRefreshAt: '2020-01-01T00:00:00Z' },
    ],
  }))
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.governed, 1)
})

test('a cycle the walk enters but is not part of is still a cycle, and the chain shows it', async () => {
  // Two mutations survived the suite on the two-table cycle above, and both
  // change what an operator reads.
  //
  // The two-table case a <- b <- a returns to the STARTING table, which is in
  // `onPath` from the first line of the walk, so deleting `onPath.add` still
  // detected it. Here a.head walks into a cycle it is not part of --
  // a.head <- b.mid <- c.tail <- b.mid -- and without that line the walk runs
  // to the depth bound instead, reporting `lineage-depth-exceeded` about a
  // lineage that does not merely go deep, it goes round.
  //
  // And deleting the `chain.push` in the cycle arm left the message saying
  // "the upstream chain a.head <- b.mid <- c.tail returns to a table it
  // already passed through" -- a sentence whose own evidence shows no repeat.
  const { policyPath, snapshotPath } = await project(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440 },
      tables: ['a.head', 'b.mid', 'c.tail'].map((name) => ({ name, maxAgeMinutes: 60 })),
    }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'a.head', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['b.mid'] },
        { name: 'b.mid', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['c.tail'] },
        { name: 'c.tail', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['b.mid'] },
      ],
    }),
  )
  const report = await auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(NOW) })

  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'lineage-cycle').length, 3, 'every governed table in or above the cycle')
  assert.equal(ruleIds(report).includes('lineage-depth-exceeded'), false, 'round, not merely deep')

  const chains = findingsFor(report, 'lineage-cycle').map((finding) => finding.message)
  const head = chains.find((message) => message.startsWith('the upstream chain a.head'))
  assert.match(head, /^the upstream chain a\.head <- b\.mid <- c\.tail <- b\.mid returns to a table it already passed through/u)

  // The repeated name is what makes the sentence checkable, so it is asserted
  // rather than left to the phrase around it.
  for (const message of chains) {
    const chain = message.slice('the upstream chain '.length).split(' returns to')[0].split(' <- ')
    assert.equal(new Set(chain).size, chain.length - 1, `one name repeats: ${chain.join(' <- ')}`)
    // And the repeat is the LAST name, closing the loop, rather than some
    // earlier coincidence: its first occurrence is somewhere before the end.
    assert.equal(chain.indexOf(chain.at(-1)) < chain.length - 1, true, chain.join(' <- '))
  }
})

test('a lineage cycle leaves the far end of the chain unnamed', async () => {
  const { policyPath, snapshotPath } = await project(
    policy({
      limits: { maxSnapshotAgeMinutes: 1440 },
      tables: [{ name: 'a.table', maxAgeMinutes: 60 }, { name: 'b.table', maxAgeMinutes: 60 }],
    }),
    snapshot({
      generatedAt: '2026-09-18T09:00:00Z',
      tables: [
        { name: 'a.table', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['b.table'] },
        { name: 'b.table', lastRefreshAt: '2026-09-18T01:00:00Z', upstream: ['a.table'] },
      ],
    }),
  )
  const report = await auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now: ms(NOW) })

  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('lineage-cycle'), true)
  assert.match(
    findingsFor(report, 'lineage-cycle')[0].message,
    /returns to a table it already passed through/u,
  )
})
