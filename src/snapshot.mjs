/**
 * Reading the exported snapshot, with every bound enforced before the work it
 * bounds.
 *
 * A problem here is EVIDENCE, not configuration: the run had a subject and
 * failed to obtain facts about it. So nothing in this file throws. Each failure
 * becomes a finding whose rule id is in `EVIDENCE_MISSING_RULES`, which makes
 * the whole report `incomplete` and the process exit 2. A snapshot that was not
 * read is never a warehouse whose tables were fresh.
 *
 * The size bound is taken from `stat` BEFORE the file is opened, because a
 * bound checked after the read has already spent the memory it was there to
 * protect. A tool in this catalog died of heap exhaustion at a size its own
 * documentation called legal.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { SNAPSHOT_SCHEMA_VERSION } from './policy.mjs'
import { parseInstant } from './time.mjs'
import { MAX_ID_LENGTH, at, isRenderableString, makeFinding, msg, parseFailureDetail, sanitize } from './rules.mjs'

/** The run states this tool reads. Only `complete` establishes a refresh. */
export const RUN_STATES = Object.freeze(['aborted', 'complete', 'failed', 'running'])

const TABLE_KEYS = ['name', 'lastRefreshAt', 'upstream']
const RUN_KEYS = ['table', 'runId', 'state', 'startedAt', 'endedAt']

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownKey(value, allowed) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) return key
  return null
}

/**
 * Read and shape-check the snapshot.
 *
 * Returns `{ ok: true, ... }`, or `{ ok: false, findings }` with at least one
 * finding naming exactly what was not established. A structural problem stops
 * the whole document rather than skipping the entry: half a lineage graph
 * answers a question about dependencies that the missing half could change.
 */
export async function readSnapshot(path, limits) {
  const file = basename(path)
  const target = resolve(path)
  const refuse = (ruleId, message, extra) => ({
    ok: false,
    findings: [makeFinding(ruleId, message, typeof extra?.pointer === 'string'
      ? at(file, extra.pointer)
      : at(file), extra)],
  })

  let stats
  try {
    stats = await stat(target)
  } catch (error) {
    return refuse(
      'snapshot-unreadable',
      msg`the snapshot could not be inspected (${error?.code ?? 'unknown error'}).`,
      { suggestion: 'Check --snapshot against the path the export actually wrote.' },
    )
  }
  if (!stats.isFile()) {
    return refuse('snapshot-unreadable', msg`--snapshot does not name a regular file.`)
  }
  if (stats.size > limits.maxSnapshotBytes) {
    return refuse(
      'snapshot-too-large',
      msg`the snapshot is ${String(stats.size)} bytes, above limits.maxSnapshotBytes
          (${String(limits.maxSnapshotBytes)}). It was not opened.`,
      { suggestion: 'Export fewer tables, or raise limits.maxSnapshotBytes up to its ceiling.' },
    )
  }

  let bytes
  try {
    bytes = await readFile(target)
  } catch (error) {
    return refuse(
      'snapshot-unreadable',
      msg`the snapshot could not be read (${error?.code ?? 'unknown error'}).`,
    )
  }

  let text
  try {
    // Strict decoding. Validity is never inferred from decoded content: a
    // document may legitimately contain U+FFFD, and a tool in this catalog
    // disabled its own encoding guard file-wide because of exactly that.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return refuse('snapshot-not-utf8', msg`the snapshot is not valid UTF-8, so it was not decoded.`)
  }

  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    return refuse('snapshot-unparsable', msg`the snapshot could not be parsed: ${parseFailureDetail(error)}.`)
  }

  if (!isPlainObject(document)) {
    return refuse('snapshot-invalid', msg`the snapshot is not a JSON object.`)
  }
  if (document.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return refuse(
      'snapshot-schema-unsupported',
      msg`the snapshot declares schemaVersion ${sanitize(document.schemaVersion, MAX_ID_LENGTH)};
          this tool reads ${SNAPSHOT_SCHEMA_VERSION}.`,
    )
  }
  const stray = unknownKey(document, ['schemaVersion', 'generatedAt', 'tables', 'runs'])
  if (stray !== null) {
    return refuse(
      'snapshot-invalid',
      msg`the snapshot has an unknown key ${stray}. A key this tool does not read may carry
          evidence it would have used, so the document is not used as if it were understood.`,
    )
  }

  const generated = parseInstant(document.generatedAt)
  if (!generated.ok) {
    return refuse(
      'snapshot-invalid',
      msg`the snapshot does not say when it was generated in a form this tool reads
          (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[.sss]Z, in UTC).`,
      { pointer: '/generatedAt' },
    )
  }

  if (!Array.isArray(document.tables)) {
    return refuse('snapshot-invalid', msg`the snapshot has no "tables" array.`, { pointer: '/tables' })
  }
  if (document.tables.length > limits.maxTables) {
    return refuse(
      'snapshot-too-many-tables',
      msg`the snapshot holds ${String(document.tables.length)} tables, above limits.maxTables
          (${String(limits.maxTables)}). No table was judged.`,
      { pointer: '/tables', suggestion: 'Export a narrower slice, or raise limits.maxTables up to its ceiling.' },
    )
  }

  const tables = new Map()
  for (const [index, entry] of document.tables.entries()) {
    const pointer = `/tables/${index}`
    if (!isPlainObject(entry)) {
      return refuse('snapshot-invalid', msg`a snapshot table entry is not an object.`, { pointer })
    }
    const strayKey = unknownKey(entry, TABLE_KEYS)
    if (strayKey !== null) {
      return refuse('snapshot-invalid', msg`a snapshot table has an unknown key ${strayKey}.`, { pointer })
    }
    if (!isRenderableString(entry.name, MAX_ID_LENGTH)) {
      return refuse('snapshot-invalid', msg`a snapshot table has no usable name.`, { pointer })
    }
    if (tables.has(entry.name)) {
      return refuse(
        'snapshot-invalid',
        msg`the snapshot names table ${entry.name} twice, so which row describes it is not settled.`,
        { pointer },
      )
    }

    let lastRefreshMs = null
    if (entry.lastRefreshAt !== undefined && entry.lastRefreshAt !== null) {
      const refreshed = parseInstant(entry.lastRefreshAt)
      if (!refreshed.ok) {
        return refuse(
          'snapshot-invalid',
          msg`table ${entry.name} has a lastRefreshAt this tool does not read
              (${sanitize(entry.lastRefreshAt, MAX_ID_LENGTH)}). It was not guessed at.`,
          { pointer: `${pointer}/lastRefreshAt` },
        )
      }
      lastRefreshMs = refreshed.ms
    }

    let upstream = []
    if (entry.upstream !== undefined) {
      if (!Array.isArray(entry.upstream)) {
        return refuse('snapshot-invalid', msg`table ${entry.name} has an "upstream" that is not an array.`, { pointer })
      }
      if (entry.upstream.length > limits.maxUpstreamPerTable) {
        return refuse(
          'upstream-limit-exceeded',
          msg`table ${entry.name} declares ${String(entry.upstream.length)} upstream tables, above
              limits.maxUpstreamPerTable (${String(limits.maxUpstreamPerTable)}). The lineage was
              not walked, so no cause was attributed anywhere in this run.`,
          { pointer, suggestion: 'Raise limits.maxUpstreamPerTable up to its ceiling, or export a narrower graph.' },
        )
      }
      for (const name of entry.upstream) {
        if (!isRenderableString(name, MAX_ID_LENGTH)) {
          return refuse('snapshot-invalid', msg`table ${entry.name} names an upstream with no usable name.`, { pointer })
        }
      }
      upstream = [...new Set(entry.upstream)]
    }

    tables.set(entry.name, { name: entry.name, pointer, lastRefreshMs, upstream })
  }

  const runs = []
  if (document.runs !== undefined) {
    if (!Array.isArray(document.runs)) {
      return refuse('snapshot-invalid', msg`the snapshot has a "runs" that is not an array.`, { pointer: '/runs' })
    }
    if (document.runs.length > limits.maxRuns) {
      return refuse(
        'snapshot-too-many-runs',
        msg`the snapshot holds ${String(document.runs.length)} run records, above limits.maxRuns
            (${String(limits.maxRuns)}). No table was judged.`,
        { pointer: '/runs', suggestion: 'Export a shorter history, or raise limits.maxRuns up to its ceiling.' },
      )
    }
    for (const [index, entry] of document.runs.entries()) {
      const pointer = `/runs/${index}`
      if (!isPlainObject(entry)) {
        return refuse('snapshot-invalid', msg`a snapshot run entry is not an object.`, { pointer })
      }
      const strayKey = unknownKey(entry, RUN_KEYS)
      if (strayKey !== null) {
        return refuse('snapshot-invalid', msg`a snapshot run has an unknown key ${strayKey}.`, { pointer })
      }
      if (!isRenderableString(entry.table, MAX_ID_LENGTH) || !isRenderableString(entry.runId, MAX_ID_LENGTH)) {
        return refuse('snapshot-invalid', msg`a snapshot run has no usable table name or run id.`, { pointer })
      }
      if (!RUN_STATES.includes(entry.state)) {
        return refuse(
          'snapshot-invalid',
          msg`run ${entry.runId} has state ${sanitize(entry.state, MAX_ID_LENGTH)}; the states this
              tool reads are ${RUN_STATES.join(', ')}.`,
          { pointer },
        )
      }
      let endedMs = null
      if (entry.endedAt !== undefined && entry.endedAt !== null) {
        const ended = parseInstant(entry.endedAt)
        if (!ended.ok) {
          return refuse(
            'snapshot-invalid',
            msg`run ${entry.runId} has an endedAt this tool does not read.`,
            { pointer: `${pointer}/endedAt` },
          )
        }
        endedMs = ended.ms
      }
      // A completed run that does not say when it ended cannot establish a
      // refresh. Treating it as one would put a timestamp in the report that
      // no document contains.
      if (entry.state === 'complete' && endedMs === null) {
        return refuse(
          'snapshot-invalid',
          msg`run ${entry.runId} is recorded as complete but does not say when it ended, so it
              cannot establish when ${entry.table} last refreshed.`,
          { pointer },
        )
      }
      runs.push({ table: entry.table, runId: entry.runId, state: entry.state, endedMs, pointer })
    }
  }

  return { ok: true, file, generatedAtMs: generated.ms, tables, runs }
}
