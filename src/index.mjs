/**
 * warehouse-freshness-auditor
 *
 * Compare the refresh timestamps in an exported snapshot against the per-table
 * deadlines a policy declares, using an instant the caller supplies, and say
 * which tables are late and why.
 *
 * Four rules govern the design, and they matter more than the arithmetic:
 *
 * 1. THE CLOCK IS AN ARGUMENT. There is no `Date.now()`, no `new Date()` with
 *    no argument and no `Date.parse` in this tool. `--now` is required and has
 *    no default, so two runs over the same documents produce byte-identical
 *    output and a freshness check can be put in a test.
 * 2. THE STATE IS AN INPUT. This tool opens no connection, resolves no host and
 *    reaches no warehouse. A refresh time is a string in a document somebody
 *    exported; an age is arithmetic between that string and `--now`.
 * 3. ABSENT HISTORY IS UNKNOWN. A table with no `lastRefreshAt` and no
 *    completed run is reported as neither fresh nor late. So is a table the
 *    snapshot does not hold, a snapshot that disagrees with itself, and a
 *    refresh dated after `--now`. Each makes the report `incomplete` and exits
 *    2, and none of them ever satisfies a deadline.
 * 4. A CAUSE IS A SEPARATE FACT FROM A VERDICT. A table can be provably late
 *    while why it is late stays unsettled. The lateness is reported as
 *    established; `cause-undetermined` is reported beside it rather than the
 *    lateness being quietly attributed to the table itself.
 *
 * The policy is configuration: a problem with it means the run never had a
 * subject, so stdout stays empty and the message goes to stderr. The snapshot
 * is evidence: a problem with it is a finding inside an `incomplete` report,
 * because a consumer needs to know which state was not established.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { auditFreshness } from './freshness.mjs'
import { readSnapshot } from './snapshot.mjs'
import { MAX_POLICY_BYTES, PolicyError, validatePolicy } from './policy.mjs'
import { minutesBetween } from './time.mjs'
import {
  RULE_IDS,
  at,
  makeFinding,
  marksEvidenceMissing,
  msg,
  parseFailureDetail,
  sortFindings,
  statusFor,
} from './rules.mjs'

export { MAX_NAMED_UPSTREAMS, UNKNOWN_REASONS, auditFreshness, refreshOf, suspensionFor } from './freshness.mjs'
export { RUN_STATES, readSnapshot } from './snapshot.mjs'
export {
  DEFAULT_LIMITS,
  LIMIT_CEILINGS,
  LIMIT_NAMES,
  MAX_AGE_MINUTES,
  MAX_OFFSET_MINUTES,
  MAX_POLICY_BYTES,
  MAX_POLICY_TABLES,
  MAX_WINDOWS,
  POLICY_SCHEMA_VERSION,
  PolicyError,
  SNAPSHOT_SCHEMA_VERSION,
  validatePolicy,
} from './policy.mjs'
export { DAY_MS, DAY_NAMES, MINUTE_MS, dayNameAt, minutesBetween, parseInstant, withinWindow } from './time.mjs'
export {
  EVIDENCE_LIMIT,
  EVIDENCE_MISSING_RULES,
  FORBIDDEN_CLAIMS,
  LINE_SEPARATORS,
  MAX_FINDINGS,
  MAX_ID_LENGTH,
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  SafeMessage,
  assertNoForbiddenClaim,
  byCodeUnit,
  compareFindings,
  describeValue,
  findForbiddenClaim,
  isRenderableString,
  makeFinding,
  marksEvidenceMissing,
  msg,
  parseFailureDetail,
  sanitize,
  severityFor,
  sortFindings,
  statusFor,
} from './rules.mjs'

export const TOOL_ID = 'warehouse-freshness-auditor'
export const REPORT_SCHEMA_VERSION = '1'

/** The rule catalog a consumer can read without running anything. */
export const CATALOG = Object.freeze({
  tool: TOOL_ID,
  ruleIds: RULE_IDS,
  evidenceMissing: Object.freeze(RULE_IDS.filter((id) => marksEvidenceMissing(id))),
})

async function readPolicy(path) {
  const target = resolve(path)
  let stats
  try {
    stats = await stat(target)
  } catch (error) {
    throw new PolicyError(`--policy could not be inspected: ${error?.code ?? 'unknown error'}.`)
  }
  if (!stats.isFile()) throw new PolicyError('--policy must name a regular file.')
  // Bounded before the read, not after it. A limit checked once the bytes are
  // already resident has spent the memory it exists to protect.
  if (stats.size > MAX_POLICY_BYTES) {
    throw new PolicyError(
      `--policy is ${stats.size} bytes, above the ${MAX_POLICY_BYTES} byte limit, so it was not opened.`,
    )
  }

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(target))
  } catch (error) {
    if (error instanceof TypeError) throw new PolicyError('--policy is not valid UTF-8.')
    throw new PolicyError(`--policy could not be read: ${error?.code ?? 'unknown error'}.`)
  }

  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new PolicyError(`--policy could not be parsed: ${parseFailureDetail(error)}.`)
  }
  return validatePolicy(document)
}

/**
 * Audit a snapshot against a policy at a given instant.
 *
 * `now` is required and is milliseconds since the epoch. There is no default,
 * because a default would be a clock read, and a freshness verdict that depends
 * on when the tool happened to run cannot be reproduced or tested.
 *
 * Throws `PolicyError` for a configuration problem -- the caller turns that
 * into an empty stdout and exit 2. Everything else comes back as a report.
 */
export async function auditSnapshot({ policy: policyPath, snapshot: snapshotPath, now }) {
  if (!Number.isFinite(now)) {
    throw new PolicyError('An instant is required: this tool never reads a clock of its own.')
  }
  const policy = await readPolicy(policyPath)

  const read = await readSnapshot(snapshotPath, policy.limits)
  const file = basename(snapshotPath)
  const findings = []
  let audit = { findings: [], checked: 0, suspended: 0, late: 0, unknown: 0 }
  let usable = false

  // `findings.push(...other)` passes one ARGUMENT per finding, and a legal
  // snapshot can produce hundreds of thousands: 1280 governed tables each
  // naming 256 absent upstreams -- inside every declared bound -- overflowed
  // the call stack, and the run ended with an empty stdout, exit 2 and
  // "Maximum call stack size exceeded", which is the shape this contract
  // reserves for a configuration error. A loop passes one argument.
  const collect = (from) => {
    for (const finding of from) findings.push(finding)
  }

  if (!read.ok) {
    collect(read.findings)
  } else if (now < read.generatedAtMs) {
    // Every age would be negative. Reporting one as an age, or clamping it to
    // zero and calling the table fresh, would both be this tool inventing a
    // number the documents do not contain.
    findings.push(makeFinding(
      'snapshot-ahead-of-clock',
      msg`the snapshot says it was generated ${String(minutesBetween(now, read.generatedAtMs))}
          minutes after the instant given to --now, so no age in it can be computed. No table was
          judged.`,
      at(file, '/generatedAt'),
      { suggestion: 'Pass the instant the audit is meant to describe, at or after the export.' },
    ))
  } else if (minutesBetween(read.generatedAtMs, now) > policy.limits.maxSnapshotAgeMinutes) {
    // A table may have refreshed since this export. Judging it against a
    // deadline now would be reporting an old document as the present state.
    findings.push(makeFinding(
      'snapshot-stale',
      msg`the snapshot was generated ${String(minutesBetween(read.generatedAtMs, now))} minutes
          before the instant given to --now, above limits.maxSnapshotAgeMinutes
          (${String(policy.limits.maxSnapshotAgeMinutes)}). A table may have refreshed since it was
          written, so no table was judged against a deadline.`,
      at(file, '/generatedAt'),
      { suggestion: 'Export a newer snapshot, or raise limits.maxSnapshotAgeMinutes up to its ceiling.' },
    ))
  } else {
    usable = true
    audit = auditFreshness({ policy, snapshot: read, nowMs: now })
    collect(audit.findings)
  }

  // A pass over nothing is the vacuous green this catalog keeps finding, and a
  // run where the policy suspended every deadline is a different thing from one
  // where nothing could be evaluated. Both are said out loud; only the second
  // is missing evidence.
  if (usable && audit.checked === 0 && audit.suspended === 0) {
    findings.push(makeFinding(
      'no-tables-checked',
      msg`none of the ${String(policy.tables.length)} governed table(s) was compared against a
          deadline, so this run establishes nothing about freshness.`,
      at(file),
      { suggestion: 'Resolve the findings above, then run the audit again.' },
    ))
  } else if (usable && audit.checked === 0) {
    findings.push(makeFinding(
      'no-deadline-in-force',
      msg`no table's deadline was in force at the instant given to --now: ${String(audit.suspended)}
          of ${String(policy.tables.length)} governed table(s) were suspended by the policy. This
          run compared no age against a limit.`,
      at(file),
      { suggestion: 'Read this beside the suspension findings before treating the run as clean.' },
    ))
  }

  const sorted = sortFindings(findings)
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: statusFor(sorted),
    summary: {
      checked: audit.checked,
      errors: sorted.filter((finding) => finding.severity === 'error').length,
      warnings: sorted.filter((finding) => finding.severity === 'warning').length,
      governed: policy.tables.length,
      suspended: audit.suspended,
      late: audit.late,
      unknown: audit.unknown,
    },
    findings: sorted,
  }
}

export function renderReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

export function formatSummary(report) {
  const { summary } = report
  const lines = [
    `${TOOL_ID}: ${report.status}`,
    `  governed ${summary.governed}, compared against a deadline ${summary.checked}`,
    `  late ${summary.late}, suspended by policy ${summary.suspended}, not established ${summary.unknown}`,
    `  findings ${report.findings.length} (errors ${summary.errors}, warnings ${summary.warnings})`,
  ]
  for (const finding of report.findings) {
    const where = [finding.location.file, finding.location.pointer].filter(Boolean).join(' ')
    lines.push(`  ${finding.severity} ${finding.ruleId} ${where}`)
    lines.push(`    ${finding.message}`)
  }
  if (report.status === 'incomplete') {
    lines.push('  incomplete: at least one table was not established as fresh or late. This is not a pass.')
  }
  return `${lines.join('\n')}\n`
}
