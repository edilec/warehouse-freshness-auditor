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
import { MAX_FINDINGS, at, byCodeUnit, makeFinding, msg, sanitize } from './rules.mjs'

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
 * Why an upstream could not be judged: the closed set, written once.
 *
 * `cause-undetermined` sorts these by code unit before printing them, and a
 * sweep reports substituting a collator at that sort as SURVIVING. That is an
 * EQUIVALENT MUTANT, and this constant is what lets the claim be checked rather
 * than taken on trust: over THESE five strings code-unit order and ICU
 * collation are the same permutation, which the test suite asserts, so a sixth
 * reason that broke the property would fail a test instead of quietly making
 * the message machine-dependent. The upstream NAMES beside them come from the
 * snapshot, can be anything, and are pinned behaviourally instead.
 */
export const UNKNOWN_REASONS = Object.freeze({
  ungoverned: 'the policy declares no maxAgeMinutes for it',
  absentTable: 'it is not in the snapshot',
  absentHistory: 'the snapshot holds no refresh history for it',
  conflict: 'the snapshot disagrees with itself about it',
  ahead: 'its last refresh is after the instant given to --now',
})

/**
 * The clause that says why a deadline is out of force, in the same words the
 * matching `sla-suspended-*` finding uses.
 *
 * Built with `msg` rather than as a plain string so its literals go through the
 * forbidden-claim check like every other sentence this tool writes, and so the
 * window id -- which comes from the policy document -- is sanitised.
 */
function describeSuspension(suspension) {
  return suspension.kind === 'maintenance'
    ? msg`maintenance window ${suspension.id}`
    : msg`the instant given to --now falls on a ${suspension.day}`
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

  // `latestCompleteRun` is built once by `readSnapshot`. Scanning the run list
  // here instead is what made a legal-sized audit take twenty-two seconds.
  const latestRun = snapshot.latestCompleteRun.get(name) ?? null

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
  let reachedLimit = false
  const emit = (ruleId, message, location, extra) => {
    if (findings.length >= MAX_FINDINGS) {
      reachedLimit = true
      return
    }
    findings.push(makeFinding(ruleId, message, location, extra))
  }

  const governed = new Map(policy.tables.map((table) => [table.name, table]))
  const reportedUpstream = new Set()

  /**
   * Late, fresh, or not decidable -- used only for attributing a cause.
   *
   * Memoised, because the lineage walk asks about the same upstream table once
   * per late descendant and the answer cannot change within a run: `nowMs` and
   * the snapshot are both fixed for its whole duration.
   *
   * A sweep reports dropping the memo as SURVIVING. That is an EQUIVALENT
   * MUTANT by construction rather than by luck -- `classifyUncached` reads only
   * those two fixed values, so repeating it returns the same answer and the
   * report is byte-identical. What it costs is time, which is what the memo is
   * here for.
   */
  const verdicts = new Map()
  const classify = (name) => {
    const cached = verdicts.get(name)
    if (cached !== undefined) return cached
    const computed = classifyUncached(name)
    verdicts.set(name, computed)
    return computed
  }

  const classifyUncached = (name) => {
    const table = governed.get(name)
    if (table === undefined) return { kind: 'unknown', why: UNKNOWN_REASONS.ungoverned }
    const refresh = refreshOf(name, snapshot)
    if (refresh.kind === 'absent-table') return { kind: 'unknown', why: UNKNOWN_REASONS.absentTable }
    if (refresh.kind === 'absent') return { kind: 'unknown', why: UNKNOWN_REASONS.absentHistory }
    if (refresh.kind === 'conflict') return { kind: 'unknown', why: UNKNOWN_REASONS.conflict }
    if (refresh.ms > nowMs) return { kind: 'unknown', why: UNKNOWN_REASONS.ahead }
    const age = minutesBetween(refresh.ms, nowMs)
    if (age <= table.maxAgeMinutes) return { kind: 'fresh', age }
    // Suspension governs REPORTING, not arithmetic: this table has still not
    // refreshed, and that is still why a governed descendant of it is late. The
    // suspension travels with the verdict because the SENTENCE has to change --
    // a report that says this table "was not compared against its deadline" may
    // not also assert it is above one.
    return { kind: 'late', age, table, suspension: suspensionFor(table, nowMs, calendar) }
  }

  /**
   * One step of the walk from one table, computed ONCE for that table.
   *
   * Upstream names are sorted by code unit before one is chosen, so a snapshot
   * that lists the same edges in a different order produces the same chain.
   *
   * Memoised for the same reason `classify` is, and it matters far more. The
   * answer depends only on the snapshot and `nowMs`, both fixed for the run,
   * and a lineage graph is normally shared: 1984 governed tables hanging off
   * one 64-deep chain used to sort and classify that chain's 256 upstreams
   * 1984 times over, allocating a gap record every time. That is
   * `governed x depth x fan-out` -- 33 million records for an input inside
   * every declared bound. Now it is one pass per table that appears in a walk.
   *
   * `gaps` is kept as the node's own array and handed out by reference, so a
   * walk collects one reference per step instead of copying every gap.
   */
  const steps = new Map()
  const stepOf = (node) => {
    const cached = steps.get(node)
    if (cached !== undefined) return cached
    const entry = snapshot.tables.get(node)
    const parents = entry === undefined ? [] : [...entry.upstream].sort(byCodeUnit)
    const gaps = []
    let next = null
    for (const parent of parents) {
      const verdict = classify(parent)
      if (verdict.kind === 'unknown') gaps.push({ child: node, upstream: parent, why: verdict.why })
      // The first late parent in code-unit order, which is the one the sorted
      // list used to yield as `late[0]`.
      else if (verdict.kind === 'late' && next === null) next = parent
    }
    const step = { next, gaps }
    steps.set(node, step)
    return step
  }

  /** Walk up from a late table to the deepest late ancestor. */
  const trace = (start) => {
    const chain = [start]
    const onPath = new Set(chain)
    const chunks = []
    let cursor = start

    for (let edges = 0; ; edges += 1) {
      const step = stepOf(cursor)
      if (step.gaps.length > 0) chunks.push(step.gaps)
      if (step.next === null) {
        return { chain, chunks, outcome: chain.length > 1 ? 'upstream' : 'local' }
      }
      // The bound is checked only once there is another edge to take, so a
      // chain of exactly maxLineageDepth edges is walked to its end and only a
      // longer one is refused. Checking it before looking for a parent refuses
      // the chain that sits exactly on the documented limit.
      if (edges === limits.maxLineageDepth) return { chain, chunks, outcome: 'depth' }
      if (onPath.has(step.next)) {
        chain.push(step.next)
        return { chain, chunks, outcome: 'cycle' }
      }
      chain.push(step.next)
      onPath.add(step.next)
      cursor = step.next
    }
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
      const rootAge = String(rootVerdict.age)
      const rootLimit = String(rootVerdict.table.maxAgeMinutes)
      if (rootVerdict.suspension === null) {
        emit(
          'table-late-upstream',
          msg`${table.name} is ${String(age)} minutes old, above its ${String(table.maxAgeMinutes)}
              minute limit, and its upstream chain ${chainText} is late at its far end: ${root} is
              ${rootAge} minutes old, above its ${rootLimit} minute limit.`,
          at(file, pointer),
          { suggestion: 'Recover the upstream at the far end of the chain first.' },
        )
      } else {
        // The policy took the far end's deadline out of force for this instant,
        // so the same report carries an `sla-suspended-*` finding saying it was
        // not compared against one. Its age is still a fact this run computed
        // and still the cause, but claiming it is "above its limit" here would
        // contradict that finding, and the operator would be sent to recover a
        // table the policy deliberately excused.
        emit(
          'table-late-upstream',
          msg`${table.name} is ${String(age)} minutes old, above its ${String(table.maxAgeMinutes)}
              minute limit, and the far end of its upstream chain ${chainText} has not refreshed
              either: ${root} is ${rootAge} minutes old, past a ${rootLimit} minute limit the policy
              has taken out of force for it (${describeSuspension(rootVerdict.suspension)}), so
              ${root} is reported as suspended rather than late.`,
          at(file, pointer),
          { suggestion: 'Decide in the policy whether this table is suspended alongside its upstream.' },
        )
      }
    } else {
      // The message is the same either way, because the lateness is the same
      // fact either way. The SUGGESTION is not: pointing at this table's own
      // job is sound only when the walk finished and found no late upstream.
      // When it was cut short by a cycle or by the depth bound, that advice
      // would be this tool attributing a cause it did not establish.
      emit(
        'table-late',
        msg`${table.name} is ${String(age)} minutes old, above its ${String(table.maxAgeMinutes)}
            minute limit.`,
        at(file, pointer),
        {
          suggestion: traced.outcome === 'local'
            ? 'Check the job that refreshes this table.'
            : 'Read the finding beside this one: the far end of its lineage was not reached.',
        },
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

    // One chunk holds every gap of one table, always the whole set, so a table
    // already reported has nothing left to report. That is the same dedupe the
    // per-(child, upstream) key performed, without building a key per gap.
    for (const chunk of traced.chunks) {
      const child = chunk[0].child
      if (reportedUpstream.has(child)) continue
      reportedUpstream.add(child)
      for (const gap of chunk) {
        if (snapshot.tables.has(gap.upstream)) continue
        emit(
          'upstream-unknown',
          msg`${gap.child} names ${gap.upstream} as an upstream, and the snapshot holds no row for
              that table, so this edge of the lineage leads nowhere this run can read.`,
          at(file, snapshot.tables.get(gap.child)?.pointer),
          { suggestion: 'Export the upstream table, or correct the lineage edge.' },
        )
      }
    }

    if (traced.chunks.length > 0) {
      const nameSet = new Set()
      const reasonSet = new Set()
      for (const chunk of traced.chunks) {
        for (const gap of chunk) {
          nameSet.add(gap.upstream)
          reasonSet.add(gap.why)
        }
      }
      const names = [...nameSet].sort(byCodeUnit)
      const reasons = [...reasonSet].sort(byCodeUnit)
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

  // Pushed directly rather than through `emit`, because the finding that says
  // the limit was reached is the one finding the limit may not drop.
  if (reachedLimit) {
    findings.push(makeFinding(
      'finding-limit-exceeded',
      msg`this audit reached its limit of ${String(MAX_FINDINGS)} findings and stopped emitting
          them, so what is reported here is not everything it found and this run does not establish
          the state of every governed table.`,
      at(file),
      { suggestion: 'Govern fewer tables in one run, or correct the lineage gaps the findings name.' },
    ))
  }

  return { findings, checked, suspended, late, unknown }
}
