/**
 * The rule catalog, the severity table, and everything that turns findings into
 * a status.
 *
 * Four defences live here, and each exists because its absence produced a green
 * build over a real failure somewhere in this catalog:
 *
 * 1. Severity is declared exactly once, in `RULE_SEVERITY`. Every finding takes
 *    its severity from that table and an unknown rule id throws rather than
 *    defaulting to something harmless.
 * 2. `status` is derived from the findings, not from a mutable flag. A table
 *    whose refresh history is absent, a snapshot too old to describe the state
 *    now, a lineage walk that could not settle a cause -- each makes the whole
 *    run `incomplete`, and there is no single assignment whose deletion would
 *    let it pass.
 * 3. A finding's message is built with the `msg` tagged template. The literals
 *    are this tool's own voice and are checked against claims it is not
 *    entitled to make -- it reads two documents and is handed an instant, and
 *    it never observes a running system -- while the interpolated values come
 *    from those documents and are sanitised.
 * 4. `sanitize` is the single boundary every untrusted string crosses, so it
 *    has to survive a value that cannot be converted to a primitive at all.
 */

/**
 * Deterministic order: UTF-16 code unit, never locale collation.
 *
 * `<` and `<=` are the same comparison here, because the equal case is already
 * answered on the line above, so a sweep that shifts the operator one step
 * reports this as surviving. That is an EQUIVALENT MUTANT and not a gap.
 */
export function byCodeUnit(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

/** The one place a severity is written down. */
export const RULE_SEVERITY = Object.freeze({
  'cause-undetermined': 'error',
  'lineage-cycle': 'error',
  'lineage-depth-exceeded': 'error',
  'no-deadline-in-force': 'info',
  'no-tables-checked': 'error',
  'policy-table-absent': 'error',
  'refresh-history-absent': 'error',
  'refresh-history-conflict': 'error',
  'refresh-in-future': 'error',
  'sla-suspended-maintenance': 'info',
  'sla-suspended-non-business-day': 'info',
  'snapshot-ahead-of-clock': 'error',
  'snapshot-invalid': 'error',
  'snapshot-not-utf8': 'error',
  'snapshot-schema-unsupported': 'error',
  'snapshot-stale': 'error',
  'snapshot-too-large': 'error',
  'snapshot-too-many-runs': 'error',
  'snapshot-too-many-tables': 'error',
  'snapshot-unparsable': 'error',
  'snapshot-unreadable': 'error',
  'table-late': 'error',
  'table-late-upstream': 'error',
  'upstream-limit-exceeded': 'error',
  'upstream-unknown': 'error',
})

/**
 * The catalog, in code-unit order.
 *
 * A mutation sweep flags this sort as SURVIVING and it is an EQUIVALENT MUTANT
 * for a reason a reader can check rather than take on trust: every id here is
 * lower-case kebab-case, and over THIS set code-unit order and ICU collation
 * are the same permutation, so substituting a collator produces an identical
 * array. That property is asserted in the test suite, so the next id that
 * breaks it fails a test instead of drifting. `byCodeUnit` stays because the
 * ordering that IS observable -- the order findings are emitted in -- is pinned
 * behaviourally on inputs where the two orders genuinely disagree.
 */
export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY).sort(byCodeUnit))

/**
 * Rules that mean the run did not obtain the evidence a verdict would need.
 * Any one of them makes the whole report `incomplete` and the process exit 2,
 * whatever the rule's own severity happens to be.
 *
 * `refresh-history-absent` is the honesty clause of this tool expressed as
 * behaviour: a table whose last refresh is not in the snapshot is neither fresh
 * nor late, and the only true thing to say about it is that this run does not
 * know. `cause-undetermined` is the same rule applied to the second question --
 * a table can be provably late while why it is late stays unsettled, and the
 * two answers are reported separately because they are separate facts.
 *
 * The two lateness verdicts, the two suspension notices and the
 * no-deadline-in-force notice are deliberately absent: those are answers the
 * run did establish.
 */
export const EVIDENCE_MISSING_RULES = Object.freeze([
  'cause-undetermined',
  'lineage-cycle',
  'lineage-depth-exceeded',
  'no-tables-checked',
  'policy-table-absent',
  'refresh-history-absent',
  'refresh-history-conflict',
  'refresh-in-future',
  'snapshot-ahead-of-clock',
  'snapshot-invalid',
  'snapshot-not-utf8',
  'snapshot-schema-unsupported',
  'snapshot-stale',
  'snapshot-too-large',
  'snapshot-too-many-runs',
  'snapshot-too-many-tables',
  'snapshot-unparsable',
  'snapshot-unreadable',
  'upstream-limit-exceeded',
  'upstream-unknown',
].sort(byCodeUnit))

const EVIDENCE_MISSING_SET = new Set(EVIDENCE_MISSING_RULES)

export const EVIDENCE_LIMIT = 200
export const MAX_ID_LENGTH = 128

/**
 * The severity table as a Map, because a property lookup is not a table lookup.
 *
 * `RULE_SEVERITY['toString']` resolves `Object.prototype.toString`: an object
 * literal answers for every member of its prototype as well as its own keys.
 * The `undefined` check above therefore did not fire for those ids, and
 * `severityFor` returned a FUNCTION. `makeFinding` then built a finding whose
 * `severity` was that function, `JSON.stringify` dropped it -- the emitted
 * finding had no `severity` field at all, which the report contract requires --
 * and `statusFor` compared it against `'error'`, found it unequal, and reported
 * the run as a pass. A Map answers for its own entries and nothing else.
 */
const SEVERITY_BY_ID = new Map(Object.entries(RULE_SEVERITY))

export function severityFor(ruleId) {
  const severity = SEVERITY_BY_ID.get(ruleId)
  // Sanitised, and not interpolated raw: a library caller can reach here with
  // a value that `String()` throws on, and an unknown rule id must produce this
  // error rather than a TypeError from the message that describes it.
  if (severity === undefined) throw new Error(`Unknown ruleId "${sanitize(ruleId, MAX_ID_LENGTH)}"`)
  return severity
}

export function marksEvidenceMissing(ruleId) {
  severityFor(ruleId)
  return EVIDENCE_MISSING_SET.has(ruleId)
}

/**
 * Words this tool is not entitled to use about its own work.
 *
 * It opens two local documents -- a policy somebody wrote and a snapshot
 * somebody exported -- and is handed the instant to treat as the present. It
 * resolves no host, opens no connection, reaches no store, and above all READS
 * NO CLOCK: every age in a finding is arithmetic between a timestamp in the
 * snapshot and the value of `--now`. A finding phrased as though this tool had
 * looked at a live system, or as though it knew what time it is, would describe
 * a capability it does not have.
 */
export const FORBIDDEN_CLAIMS = Object.freeze([
  'query', 'queries', 'queried', 'querying',
  'connect', 'connects', 'connected', 'connection',
  'network', 'fetch', 'fetches', 'fetched', 'polled', 'polling',
  'the system clock', 'wall clock', 'current time', 'the time now',
  'today', 'tonight', 'yesterday', 'tomorrow', 'right now', 'at this moment',
  'live', 'in production', 'crawl', 'crawled',
])

const FORBIDDEN_PATTERN = new RegExp(
  `\\b(?:${FORBIDDEN_CLAIMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})\\b`,
  'iu',
)

export function findForbiddenClaim(text) {
  const match = FORBIDDEN_PATTERN.exec(describeValue(text))
  return match === null ? null : match[0]
}

export function assertNoForbiddenClaim(text, what) {
  const term = findForbiddenClaim(text)
  if (term !== null) {
    throw new Error(
      `${what} may not claim this tool observed a running system or read a clock: "${term}". `
      + 'It reads a policy document and a snapshot document, and is handed the instant to use.',
    )
  }
}

/**
 * U+2028 and U+2029, written as escape text so that no editor, transfer or
 * copy-paste can quietly turn the escape into the character it names.
 */
export const LINE_SEPARATORS = '\u2028\u2029'

/**
 * Everything stripped from an untrusted string before it reaches output.
 *
 * `\p{Cc}` is C0, DEL and C1 -- U+0085 and U+009B forge lines in a human report
 * just as a newline does. `\p{Cf}` is the bidi controls and the other invisible
 * format characters, which reorder or hide displayed text. The two separators
 * are in neither class and have to be named.
 */
const UNSAFE_CHARACTERS = new RegExp(`[\\p{Cc}\\p{Cf}${LINE_SEPARATORS}]`, 'gu')

/**
 * Describe any value as a string without ever letting it stop the run.
 *
 * `String({ toString: {} })` throws `Cannot convert object to primitive value`,
 * and a snapshot is JSON this tool did not write: `{"name": {"toString": {}}}`
 * parses into exactly that. A value that will not convert is described by its
 * shape and never reproduced.
 *
 * Only the array branch changes an answer. A sweep reports the first three as
 * SURVIVING and they are EQUIVALENT MUTANTS for a checkable reason: with any of
 * them deleted the value falls through to `String(value)`, and `String` of a
 * primitive string is that same string, `String(null)` is `'null'` and
 * `String(undefined)` is `'undefined'` -- the identical three answers, none of
 * which can throw on the way. They are the fast path for the case that
 * dominates, since every identifier this tool sanitises is already a string.
 *
 * `Array.isArray` is the one that earns a test, because `String(['1'])` is
 * `'1'`, which reads like a value rather than like an array.
 */
export function describeValue(value) {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return '[array]'
  try {
    return String(value)
  } catch {
    return typeof value === 'function' ? '[function]' : '[object]'
  }
}

/**
 * A bounded, control-character-free rendering of an untrusted string.
 *
 * Table names, run ids and window ids all arrive from input documents and all
 * reach the report and the human summary, so every one of them passes through
 * here -- not only the `evidence` field. A shipped tool in this catalog
 * sanitised its evidence carefully and let an identifier carrying a newline
 * forge whole lines in the report.
 */
export function sanitize(value, limit = EVIDENCE_LIMIT) {
  const flat = describeValue(value)
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat
}

/**
 * Whether a value is a string that still says something once sanitised.
 *
 * `value.trim().length > 0` is the wrong question and has shipped as a bug:
 * `trim` removes the ECMAScript `WhiteSpace` and `LineTerminator` productions
 * and nothing else, so a string of U+0001 or U+200E passes it and then reaches
 * output as nothing at all. Validate the form that will be emitted.
 *
 * The two productions are named separately because the difference bites both
 * ways: U+2028 and U+2029 are `LineTerminator` rather than `WhiteSpace`, and
 * `trim` removes them, so "trim keeps everything the sanitiser strips" would be
 * false about exactly those two.
 */
export function isRenderableString(value, limit = MAX_ID_LENGTH) {
  return typeof value === 'string' && value.length <= limit && sanitize(value, limit) !== ''
}

/** A number as the report prints it: finite, bounded, no exponent surprises. */
export function num(value) {
  if (!Number.isFinite(value)) return describeValue(value)
  const rounded = Math.round(value * 10000) / 10000
  // `String(-0)` is already `'0'` in ECMAScript, so this arm changes no byte
  // today and a sweep reports removing it as surviving -- an EQUIVALENT MUTANT.
  // It stays as the one thing that would keep a negative zero out of a report
  // if the rounding step above were ever replaced with something that formats
  // it differently, which is how `-0` reaches output in other languages.
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/u

/**
 * The shape that quotes the input. Recognised FIRST, and the order is the whole
 * guard: a document whose own text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so looking for the
 * offset first finds that phrase INSIDE the quoted span and slices the document
 * straight back out. The `s` flag matters too -- the quoted span can carry a
 * newline, and a non-dotAll pattern silently fails to recognise the shape it is
 * there to catch. A leading ellipsis means the quoted run came from the middle
 * of the document rather than from its start.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/su

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say what a `JSON.parse` failure was, without reproducing the document.
 *
 * V8 reports a parse failure two ways and one of them quotes the input back:
 * `Unexpected token 'N', "NOTAREALTOKEN0000EXAMPLE" is not valid JSON`. A document
 * short enough to be only a credential is therefore reproduced in full by its
 * own error message, and `sanitize` does not stop that -- it strips control
 * characters and cuts from the end, while the quoted input sits at the front.
 *
 * The closing guard is deliberate belt and braces and is why this function is
 * safe against wordings it has never seen: across the measured corpus of V8
 * parse messages, every message carrying no quoted snippet carries no double
 * quote at all, because V8 quotes JSON punctuation with apostrophes. A double
 * quote surviving to the end therefore means a snippet survived, whatever the
 * branches above concluded, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = describeValue(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

/** A message whose literals have been checked and whose values are sanitised. */
export class SafeMessage {
  constructor(text) {
    this.text = text
    Object.freeze(this)
  }

  toString() {
    return this.text
  }
}

/**
 * Build a finding message.
 *
 * The tagged-template split is the point: `strings` is this tool's own voice
 * and is checked for claims it is not entitled to make, while `values` come
 * from input documents and are only sanitised. A table literally named
 * `ops.live_query_log` must not stop the run, and a sentence this tool wrote
 * claiming it read a clock must not ship.
 */
export function msg(strings, ...values) {
  let out = ''
  for (let index = 0; index < strings.length; index += 1) {
    // Runs of whitespace in the tool's own literals collapse to one space, so a
    // sentence may be wrapped across source lines without wrapping the report,
    // and so a phrase this tool may not use cannot be hidden by a line break.
    const literal = strings[index].replace(/\s+/gu, ' ')
    assertNoForbiddenClaim(literal, 'A finding message')
    out += literal
    if (index < values.length) out += sanitize(values[index])
  }
  return new SafeMessage(out)
}

export function at(file, pointer) {
  const location = {}
  if (file !== null && file !== undefined) location.file = file
  if (pointer !== null && pointer !== undefined) location.pointer = pointer
  return location
}

export function makeFinding(ruleId, message, location, extra = {}) {
  if (!(message instanceof SafeMessage)) {
    throw new Error(`Finding "${ruleId}" must build its message with the msg tagged template`)
  }
  const finding = { ruleId, severity: severityFor(ruleId), message: message.text, location }
  if (extra.evidence !== undefined) finding.evidence = sanitize(extra.evidence)
  if (extra.suggestion !== undefined) {
    assertNoForbiddenClaim(extra.suggestion, 'A finding suggestion')
    // The suggestion crosses the same boundary as everything else that reaches
    // output. Every call site builds it from this tool's own literals today, so
    // sanitising changes no byte of any current report -- which is exactly why
    // it is the string most likely to skip the boundary, and exactly the shape
    // of an invariant that is true only by accident.
    finding.suggestion = sanitize(extra.suggestion)
  }
  return finding
}

/** Findings sort by (file, pointer, ruleId, message), each by code unit. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file ?? '', b.location.file ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '')
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}

/**
 * Status is a function of the findings alone.
 *
 * Missing evidence outranks everything, including an error: a run that could
 * not establish when half its tables last refreshed has not established that
 * the other half is the whole story. There is no flag to delete.
 */
export function statusFor(findings) {
  for (const finding of findings) {
    if (EVIDENCE_MISSING_SET.has(finding.ruleId)) return 'incomplete'
  }
  for (const finding of findings) {
    if (finding.severity === 'error') return 'fail'
  }
  return 'pass'
}
