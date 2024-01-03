/**
 * Freshness, and the second question a freshness report has to answer: why.
 *
 * Every governed table gets exactly one of three answers, and there is no
 * fourth:
 *
 *   - it refreshed within its declared limit,
 *   - it did not, which is a VERDICT this run established,
 *   - when it last refreshed is not in the snapshot, which is EVIDENCE this run
 *     did not get.
 *
 * The third answer is the point of the tool. A table with no `lastRefreshAt`
 * and no completed run is not fresh and is not late: nothing in the documents
 * says when it refreshed, so `refresh-history-absent` is reported, the run is
 * `incomplete`, and the process exits 2. Absent history is never a pass, and it
 * is never a failure either -- inventing a verdict in either direction would be
 * this tool answering a question the evidence did not.
 *
 * The same rule governs the CAUSE, separately. A table can be provably late
 * while why it is late stays unsettled: an upstream the snapshot does not hold,
 * an upstream whose own history is absent, or an upstream the policy does not
 * govern and for which there is therefore no deadline to compare against. In
 * each case the lateness is reported as the established fact it is, and
 * `cause-undetermined` is reported beside it. Quietly attributing the lateness
 * to the table itself would be a positive claim -- "nothing upstream is at
 * fault" -- resting on upstreams this run could not evaluate.
 */

import { dayNameAt, minutesBetween, withinWindow } from './time.mjs'
import { at, byCodeUnit, makeFinding, msg, sanitize } from './rules.mjs'

/** How many upstream names one message spells out before it counts the rest. */
export const MAX_NAMED_UPSTREAMS = 5

function nameList(names) {
  const shown = names.slice(0, MAX_NAMED_UPSTREAMS).map((name) => sanitize(name))
  const rest = names.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

/**
 * Whether the policy takes this table's deadline out of force at this instant.
 *
 * Windows are tried in the order the policy declares them and the first match
 * wins, so the finding a run emits does not depend on iteration order.
 */
export function suspensionFor(table, nowMs, calendar) {
  if (table.suspendOnNonBusinessDays && calendar.businessDays !== null) {
    const day = dayNameAt(nowMs, calendar.offsetMinutes)
    if (!calendar.businessDays.has(day)) return { kind: 'non-business-day', day }
  }
  if (table.suspendDuringMaintenance) {
    for (const window of calendar.maintenanceWindows) {
      if (window.tables !== null && !window.tables.has(table.name)) continue
      if (withinWindow(nowMs, window)) return { kind: 'maintenance', id: window.id }
    }
  }
  return null
}

/**
 * When a table last refreshed, according to the snapshot alone.
 *
 * `lastRefreshAt` is the statement; a completed run that ended LATER than it
 * contradicts that statement, and the snapshot then disagrees with itself about
 * the one fact this tool exists to read. Taking either value would be picking a
 * winner, so the disagreement is reported and no age is computed.
 */
export function refreshOf(name, snapshot) {
  const entry = snapshot.tables.get(name)
  if (entry === undefined) return { kind: 'absent-table' }

  let latestRun = null
  for (const run of snapshot.runs) {
    if (run.table !== name || run.state !== 'complete') continue
    if (latestRun === null || run.endedMs > latestRun.endedMs) latestRun = run
  }

  if (entry.lastRefreshMs === null) {
    if (latestRun === null) return { kind: 'absent', entry }
    return { kind: 'known', ms: latestRun.endedMs, source: `run ${latestRun.runId}`, entry }
  }
  if (latestRun !== null && latestRun.endedMs > entry.lastRefreshMs) {
    return { kind: 'conflict', entry, declaredMs: entry.lastRefreshMs, runMs: latestRun.endedMs, run: latestRun }
  }
  return { kind: 'known', ms: entry.lastRefreshMs, source: 'lastRefreshAt', entry }
}

/**
 * Audit every governed table.
 *
 * `checked` counts tables that were compared against a deadline. A suspended
 * table is counted separately, because the policy took its deadline out of
 * force and that is an answer rather than a gap; a table whose history is
 * absent is counted as unknown, because it is a gap rather than an answer.
 */
export function auditFreshness({ policy, snapshot, nowMs }) {
  const findings = []
  const { calendar, limits } = policy
  const file = snapshot.file
  const emit = (ruleId, message, location, extra) => {
    findings.push(makeFinding(ruleId, message, location, extra))
  }

  const governed = new Map(policy.tables.map((table) => [table.name, table]))
  const reportedUpstream = new Set()

  /** Late, fresh, or not decidable -- used only for attributing a cause. */
  const classify = (name) => {
    const table = governed.get(name)
    if (table === undefined) return { kind: 'unknown', why: 'the policy declares no maxAgeMinutes for it' }
    const refresh = refreshOf(name, snapshot)
    if (refresh.kind === 'absent-table') return { kind: 'unknown', why: 'it is not in the snapshot' }
    if (refresh.kind === 'absent') return { kind: 'unknown', why: 'the snapshot holds no refresh history for it' }
    if (refresh.kind === 'conflict') return { kind: 'unknown', why: 'the snapshot disagrees with itself about it' }
    if (refresh.ms > nowMs) return { kind: 'unknown', why: 'its last refresh is after the instant given to --now' }
    const age = minutesBetween(refresh.ms, nowMs)
    return age > table.maxAgeMinutes ? { kind: 'late', age, table } : { kind: 'fresh', age }
  }

  /**
   * Walk up from a late table to the deepest late ancestor.
   *
   * Upstream names are sorted by code unit before one is chosen, so a snapshot
   * that lists the same edges in a different order produces the same chain.
   */
  const trace = (start) => {
    const chain = [start]
    const onPath = new Set(chain)
    const unknowns = []
    let cursor = start
    let outcome = 'local'

    for (let edges = 0; edges <= limits.maxLineageDepth; edges += 1) {
      if (edges === limits.maxLineageDepth) return { chain, unknowns, outcome: 'depth' }
      const entry = snapshot.tables.get(cursor)
      const parents = entry === undefined ? [] : [...entry.upstream].sort(byCodeUnit)
      const late = []
      for (const parent of parents) {
        const verdict = classify(parent)
        if (verdict.kind === 'unknown') unknowns.push({ child: cursor, upstream: parent, why: verdict.why })
        else if (verdict.kind === 'late') late.push(parent)
      }
      if (late.length === 0) {
        outcome = chain.length > 1 ? 'upstream' : 'local'
        break
      }
      const next = late[0]
      if (onPath.has(next)) {
        chain.push(next)
        return { chain, unknowns, outcome: 'cycle' }
      }
      chain.push(next)
      onPath.add(next)
      cursor = next
    }
    return { chain, unknowns, outcome }
  }

  let checked = 0
  let suspended = 0
  let late = 0
  let unknown = 0

  for (const table of policy.tables) {
    const refresh = refreshOf(table.name, snapshot)
    const pointer = refresh.entry?.pointer

    if (refresh.kind === 'absent-table') {
      unknown += 1
      emit(
        'policy-table-absent',
        msg`the policy governs ${table.name}, and the snapshot holds no row for it, so whether it
            refreshed within ${String(table.maxAgeMinutes)} minutes was not established.`,
        at(file),
        { suggestion: 'Export the table, or stop governing it in the policy.' },
      )
      continue
    }
    if (refresh.kind === 'absent') {
      unknown += 1
      emit(
        'refresh-history-absent',
        msg`${table.name} has no lastRefreshAt and no completed run in this snapshot, so when it
            last refreshed is unknown. It is reported as neither fresh nor late, because nothing
            in these documents says which it is.`,
        at(file, pointer),
        { suggestion: 'Export lastRefreshAt for the table, or include its completed run records.' },
      )
      continue
    }
    if (refresh.kind === 'conflict') {
      unknown += 1
      emit(
        'refresh-history-conflict',
        msg`${table.name} declares a lastRefreshAt that a completed run (${refresh.run.runId})
            ended after, so the snapshot disagrees with itself about when the table last
            refreshed. Neither value was chosen and no age was computed.`,
        at(file, pointer),
        { suggestion: 'Export both fields from the same moment, or drop one of them.' },
      )
      continue
    }
    if (refresh.ms > nowMs) {
      unknown += 1
      emit(
        'refresh-in-future',
        msg`${table.name} last refreshed ${String(minutesBetween(nowMs, refresh.ms))} minutes after
            the instant given to --now, so its age is not a quantity this run can state.`,
        at(file, pointer),
        { suggestion: 'Check the instant passed to --now against the exporting system.' },
      )
      continue
    }

    const suspension = suspensionFor(table, nowMs, calendar)
    if (suspension !== null) {
      suspended += 1
      if (suspension.kind === 'non-business-day') {
        emit(
          'sla-suspended-non-business-day',
          msg`${table.name} was not compared against its deadline: the instant given to --now falls
              on a ${suspension.day}, which the policy's businessDays does not include, and the
              table sets suspendOnNonBusinessDays.`,
          at(file, pointer),
        )
      } else {
        emit(
          'sla-suspended-maintenance',
          msg`${table.name} was not compared against its deadline: the instant given to --now falls
              inside maintenance window ${suspension.id}, and the table sets
              suspendDuringMaintenance.`,
          at(file, pointer),
        )
      }
      continue
    }

    checked += 1
    const age = minutesBetween(refresh.ms, nowMs)
    if (age <= table.maxAgeMinutes) continue

    late += 1
    const traced = trace(table.name)
    const chainText = traced.chain.map((name) => sanitize(name)).join(' <- ')

    if (traced.outcome === 'upstream') {
      const root = traced.chain.at(-1)
      const rootVerdict = classify(root)
      emit(
        'table-late-upstream',
        msg`${table.name} is ${String(age)} minutes old, above its ${String(table.maxAgeMinutes)}
            minute limit, and its upstream chain ${chainText} is late at its far end: ${root} is
            ${String(rootVerdict.age)} minutes old, above its ${String(rootVerdict.table.maxAgeMinutes)}
            minute limit.`,
        at(file, pointer),
        { suggestion: 'Recover the upstream at the far end of the chain first.' },
      )
    } else {
      emit(
        'table-late',
        msg`${table.name} is ${String(age)} minutes old, above its ${String(table.maxAgeMinutes)}
            minute limit.`,
        at(file, pointer),
        { suggestion: 'Check the job that refreshes this table.' },
      )
    }

    if (traced.outcome === 'cycle') {
      emit(
        'lineage-cycle',
        msg`the upstream chain ${chainText} returns to a table it already passed through, so the
            far end of this table's lineage is not a place this run can name.`,
        at(file, pointer),
        { suggestion: 'Correct the exported lineage so it has no cycle.' },
      )
    }
    if (traced.outcome === 'depth') {
      emit(
        'lineage-depth-exceeded',
        msg`the upstream chain from ${table.name} is longer than limits.maxLineageDepth
            (${String(limits.maxLineageDepth)}), so the far end of it was not reached and no root
            cause was attributed.`,
        at(file, pointer),
        { suggestion: 'Raise limits.maxLineageDepth up to its ceiling.' },
      )
    }

    for (const gap of traced.unknowns) {
      if (snapshot.tables.has(gap.upstream)) continue
      const key = JSON.stringify([gap.child, gap.upstream])
      if (reportedUpstream.has(key)) continue
      reportedUpstream.add(key)
      emit(
        'upstream-unknown',
        msg`${gap.child} names ${gap.upstream} as an upstream, and the snapshot holds no row for
            that table, so this edge of the lineage leads nowhere this run can read.`,
        at(file, snapshot.tables.get(gap.child)?.pointer),
        { suggestion: 'Export the upstream table, or correct the lineage edge.' },
      )
    }

    if (traced.unknowns.length > 0) {
      const names = [...new Set(traced.unknowns.map((gap) => gap.upstream))].sort(byCodeUnit)
      const reasons = [...new Set(traced.unknowns.map((gap) => gap.why))].sort(byCodeUnit)
      emit(
        'cause-undetermined',
        msg`${table.name} is late, and why is not settled: ${nameList(names)} could not be judged
            (${reasons.join('; ')}). Reporting this lateness as having no upstream cause would be a
            claim about tables this run did not evaluate.`,
        at(file, pointer),
        { suggestion: 'Govern the upstream tables in the policy, or export their refresh history.' },
      )
    }
  }

  return { findings, checked, suspended, late, unknown }
}
