/**
 * The policy document: configuration, and therefore never a finding.
 *
 * A problem here means the run never had a subject. Per the report contract
 * that is a configuration error: stdout stays EMPTY, the message goes to
 * stderr, and the process exits 2. Nothing in this file produces a report.
 *
 * Unknown keys are refused everywhere. A one-character typo in a limit name or
 * in `suspendOnNonBusinessDays` must not silently restore the default and turn
 * a real failure into a green run -- that has happened in this catalog and it
 * is why every object below is closed rather than open.
 *
 * There are no built-in deadlines. Every `maxAgeMinutes` a table is judged
 * against comes from this document; a table the policy does not name is not
 * governed, and no age this tool invented is ever applied to one.
 */

import { DAY_NAMES, parseInstant } from './time.mjs'
import { MAX_ID_LENGTH, isRenderableString, sanitize } from './rules.mjs'

export class PolicyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PolicyError'
  }
}

export const POLICY_SCHEMA_VERSION = '1'
export const SNAPSHOT_SCHEMA_VERSION = '1'

/**
 * Bounds that are not configurable, because they bound the policy document
 * itself. A limit a document could raise would be no limit at all.
 */
export const MAX_POLICY_BYTES = 1048576
export const MAX_POLICY_TABLES = 2048
export const MAX_WINDOWS = 256
export const MAX_AGE_MINUTES = 525600
export const MAX_OFFSET_MINUTES = 1440

/** Bounds a policy may lower. It may never raise one past its ceiling. */
export const LIMIT_CEILINGS = Object.freeze({
  maxLineageDepth: 64,
  maxRuns: 100000,
  maxSnapshotAgeMinutes: 43200,
  maxSnapshotBytes: 16777216,
  maxTables: 20000,
  maxUpstreamPerTable: 256,
})

export const DEFAULT_LIMITS = Object.freeze({
  maxLineageDepth: 16,
  maxRuns: 20000,
  maxSnapshotAgeMinutes: 1440,
  maxSnapshotBytes: 4194304,
  maxTables: 5000,
  maxUpstreamPerTable: 64,
})

export const LIMIT_NAMES = Object.freeze(Object.keys(LIMIT_CEILINGS).sort())

const TABLE_KEYS = ['name', 'maxAgeMinutes', 'suspendOnNonBusinessDays', 'suspendDuringMaintenance']
const WINDOW_KEYS = ['id', 'start', 'end', 'tables']
const CALENDAR_KEYS = ['offsetMinutes', 'businessDays', 'maintenanceWindows']

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuseUnknownKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new PolicyError(`${where} has an unknown key "${sanitize(key, MAX_ID_LENGTH)}".`)
    }
  }
}

function requireName(value, where) {
  if (!isRenderableString(value, MAX_ID_LENGTH)) {
    throw new PolicyError(
      `${where} must be a non-empty string of at most ${MAX_ID_LENGTH} characters that still `
      + 'renders as something once control and format characters are removed.',
    )
  }
  return value
}

function requireBoolean(value, where) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new PolicyError(`${where} must be true or false.`)
  return value
}

function requireInstant(value, where) {
  const instant = parseInstant(value)
  if (!instant.ok) {
    throw new PolicyError(
      `${where} must be an instant written as YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[.sss]Z, `
      + `in UTC. This document says "${sanitize(value, MAX_ID_LENGTH)}".`,
    )
  }
  return instant.ms
}

function validateLimits(raw) {
  if (raw === undefined) return { ...DEFAULT_LIMITS }
  if (!isPlainObject(raw)) throw new PolicyError('"limits" must be an object.')
  refuseUnknownKeys(raw, LIMIT_NAMES, '"limits"')
  const limits = { ...DEFAULT_LIMITS }
  for (const name of LIMIT_NAMES) {
    if (!Object.hasOwn(raw, name)) continue
    const value = raw[name]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PolicyError(`"limits.${name}" must be an integer of at least 1.`)
    }
    if (value > LIMIT_CEILINGS[name]) {
      throw new PolicyError(
        `"limits.${name}" is ${value}, above the ceiling of ${LIMIT_CEILINGS[name]}. `
        + 'A policy may lower a bound and may never raise one.',
      )
    }
    limits[name] = value
  }
  return limits
}

function validateWindows(raw, tableNames) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new PolicyError('"calendar.maintenanceWindows" must be an array.')
  if (raw.length > MAX_WINDOWS) {
    throw new PolicyError(
      `"calendar.maintenanceWindows" holds ${raw.length} entries; at most ${MAX_WINDOWS} are supported.`,
    )
  }
  const windows = []
  const ids = new Set()
  for (const [index, entry] of raw.entries()) {
    const where = `"calendar.maintenanceWindows[${index}]"`
    if (!isPlainObject(entry)) throw new PolicyError(`${where} must be an object.`)
    refuseUnknownKeys(entry, WINDOW_KEYS, where)
    for (const key of ['id', 'start', 'end']) {
      if (!Object.hasOwn(entry, key)) throw new PolicyError(`${where} is missing "${key}".`)
    }
    const id = requireName(entry.id, `${where}.id`)
    if (ids.has(id)) throw new PolicyError(`${where}.id "${sanitize(id, MAX_ID_LENGTH)}" is declared twice.`)
    ids.add(id)
    const startMs = requireInstant(entry.start, `${where}.start`)
    const endMs = requireInstant(entry.end, `${where}.end`)
    if (endMs <= startMs) {
      throw new PolicyError(`${where} ends at or before it starts, so it covers no instant.`)
    }
    let tables = null
    if (Object.hasOwn(entry, 'tables')) {
      if (!Array.isArray(entry.tables) || entry.tables.length === 0) {
        throw new PolicyError(`${where}.tables must be a non-empty array, or be left out to mean every table.`)
      }
      tables = new Set()
      for (const [position, name] of entry.tables.entries()) {
        requireName(name, `${where}.tables[${position}]`)
        if (!tableNames.has(name)) {
          throw new PolicyError(
            `${where}.tables names "${sanitize(name, MAX_ID_LENGTH)}", which is not in "tables". `
            + 'A window over a table the policy does not govern would never apply.',
          )
        }
        tables.add(name)
      }
    }
    windows.push({ id, startMs, endMs, tables })
  }
  return windows
}

function validateCalendar(raw, tableNames) {
  if (raw === undefined) return { offsetMinutes: 0, businessDays: null, maintenanceWindows: [] }
  if (!isPlainObject(raw)) throw new PolicyError('"calendar" must be an object.')
  refuseUnknownKeys(raw, CALENDAR_KEYS, '"calendar"')

  let offsetMinutes = 0
  if (Object.hasOwn(raw, 'offsetMinutes')) {
    const value = raw.offsetMinutes
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_OFFSET_MINUTES) {
      throw new PolicyError(
        `"calendar.offsetMinutes" must be a whole number of minutes between `
        + `${-MAX_OFFSET_MINUTES} and ${MAX_OFFSET_MINUTES}.`,
      )
    }
    offsetMinutes = value
  }

  let businessDays = null
  if (Object.hasOwn(raw, 'businessDays')) {
    const value = raw.businessDays
    if (!Array.isArray(value) || value.length === 0) {
      throw new PolicyError('"calendar.businessDays" must be a non-empty array of day names.')
    }
    businessDays = new Set()
    for (const [index, day] of value.entries()) {
      if (!DAY_NAMES.includes(day)) {
        throw new PolicyError(
          `"calendar.businessDays[${index}]" is "${sanitize(day, MAX_ID_LENGTH)}"; `
          + `the day names are ${[...DAY_NAMES].sort().join(', ')}.`,
        )
      }
      if (businessDays.has(day)) throw new PolicyError(`"calendar.businessDays" names "${day}" twice.`)
      businessDays.add(day)
    }
  }

  return {
    offsetMinutes,
    businessDays,
    maintenanceWindows: validateWindows(raw.maintenanceWindows, tableNames),
  }
}

function validateTables(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PolicyError('"tables" must be a non-empty array.')
  }
  if (raw.length > MAX_POLICY_TABLES) {
    throw new PolicyError(
      `"tables" holds ${raw.length} entries; at most ${MAX_POLICY_TABLES} are supported.`,
    )
  }
  const tables = []
  const names = new Set()
  for (const [index, entry] of raw.entries()) {
    const where = `"tables[${index}]"`
    if (!isPlainObject(entry)) throw new PolicyError(`${where} must be an object.`)
    refuseUnknownKeys(entry, TABLE_KEYS, where)
    const name = requireName(entry.name, `${where}.name`)
    if (names.has(name)) {
      throw new PolicyError(`${where}.name "${sanitize(name, MAX_ID_LENGTH)}" is declared twice.`)
    }
    names.add(name)
    const maxAgeMinutes = entry.maxAgeMinutes
    if (!Number.isSafeInteger(maxAgeMinutes) || maxAgeMinutes < 1 || maxAgeMinutes > MAX_AGE_MINUTES) {
      throw new PolicyError(
        `${where}.maxAgeMinutes must be an integer between 1 and ${MAX_AGE_MINUTES}. `
        + 'There is no built-in deadline to fall back on.',
      )
    }
    tables.push({
      name,
      maxAgeMinutes,
      suspendOnNonBusinessDays: requireBoolean(entry.suspendOnNonBusinessDays, `${where}.suspendOnNonBusinessDays`),
      suspendDuringMaintenance: requireBoolean(entry.suspendDuringMaintenance, `${where}.suspendDuringMaintenance`),
    })
  }
  return tables
}

export function validatePolicy(document) {
  if (!isPlainObject(document)) throw new PolicyError('The policy document must be a JSON object.')
  refuseUnknownKeys(document, ['schemaVersion', 'limits', 'calendar', 'tables'], 'The policy document')
  if (document.schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new PolicyError(
      `"schemaVersion" must be "${POLICY_SCHEMA_VERSION}"; this document says `
      + `"${sanitize(document.schemaVersion, MAX_ID_LENGTH)}".`,
    )
  }
  const limits = validateLimits(document.limits)
  const tables = validateTables(document.tables)
  const calendar = validateCalendar(document.calendar, new Set(tables.map((table) => table.name)))

  // A table that asks to be suspended on a non-business day needs the policy to
  // say which days those are. Inventing Monday to Friday here would be this
  // tool deciding somebody's working week for them, and it would do it silently.
  const asks = tables.find((table) => table.suspendOnNonBusinessDays)
  if (asks !== undefined && calendar.businessDays === null) {
    throw new PolicyError(
      `"${sanitize(asks.name, MAX_ID_LENGTH)}" sets suspendOnNonBusinessDays, but `
      + '"calendar.businessDays" is not declared, so there is nothing to suspend it against. '
      + 'Declare the working week; no default is assumed.',
    )
  }

  return { limits, calendar, tables }
}
