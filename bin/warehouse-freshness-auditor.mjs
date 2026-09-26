#!/usr/bin/env node

import { auditSnapshot, exitCodeFor, formatSummary, parseInstant, renderReport } from '../src/index.mjs'

const HELP = `warehouse-freshness-auditor

Compare the refresh timestamps in an exported snapshot against the per-table
deadlines a policy declares, at an instant you supply, and say which tables are
late and why.

This tool reaches nothing and reads no clock. It opens a policy document and a
snapshot document, and --now is the present. There is no default for it: a
default would be a clock read, and a freshness verdict that depends on when the
tool happened to run cannot be reproduced or put in a test. Two runs over the
same documents produce byte-identical output. No file is written: the report
goes to stdout, so redirect it if you want to keep it.

Absent history is unknown. A table with no lastRefreshAt and no completed run is
reported as neither fresh nor late -- so is a table the snapshot does not hold, a
snapshot that disagrees with itself, and a refresh dated after --now. Each makes
the report "incomplete" and the exit code 2, and none of them satisfies a
deadline.

A cause is a separate fact from a verdict. When a late table's upstream chain is
itself late, the finding names the chain and its far end. When an upstream cannot
be judged -- it is not in the snapshot, its own history is absent, or the policy
declares no deadline for it -- the lateness is still reported, and
cause-undetermined is reported beside it rather than the lateness being quietly
blamed on the table itself.

Weekends and maintenance windows follow the policy and nothing else. A table is
suspended only when it opts in, and "non-business day" means only what
calendar.businessDays says it means -- no working week is assumed. A suspended
table is not compared against its deadline, and the run says so rather than
reporting it as fresh.

Usage:
  warehouse-freshness-auditor --policy FILE --snapshot FILE --now INSTANT [--json]

Options:
  --policy FILE     Policy document: per-table deadlines, calendar, limits (required)
  --snapshot FILE   Exported snapshot: tables, lineage and run records (required)
  --now INSTANT     The instant to treat as the present, as YYYY-MM-DD or
                    YYYY-MM-DDTHH:MM:SS[.sss]Z, in UTC (required, no default)
  --json            Suppress the human summary on stderr
  -h, --help        Show this help

Neither path is confined to a root: this tool takes two documents the caller
names, and a symbolically linked parent directory is followed, exactly as it is
for cp and shell redirection. It writes nothing anywhere.

Streams:
  stdout  the JSON report and nothing else, so it can be piped into a parser
  stderr  the human summary and any diagnostics

Exit codes:
  0  every governed table was established as within its deadline, or had its
     deadline suspended by the policy
  1  the check completed and at least one table is late
  2  invalid configuration, or evidence the check could not obtain.
     On a configuration error -- including any problem with the policy document
     -- stdout stays EMPTY and the message goes to stderr. On an unreadable
     snapshot, absent refresh history, or a lateness whose cause could not be
     settled, stdout carries an "incomplete" report naming what was not
     established.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { policy: null, snapshot: null, now: null, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--policy') options.policy = takeValue('--policy')
    else if (argument === '--snapshot') options.snapshot = takeValue('--snapshot')
    else if (argument === '--now') {
      const instant = parseInstant(takeValue('--now'))
      if (!instant.ok) throw new Error('--now requires YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[.sss]Z, in UTC')
      options.now = instant.ms
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.policy === null) throw new Error('--policy is required')
  if (options.snapshot === null) throw new Error('--snapshot is required')
  if (options.now === null) {
    throw new Error('--now is required: this tool never reads a clock of its own')
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await auditSnapshot({
      policy: options.policy,
      snapshot: options.snapshot,
      now: options.now,
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(formatSummary(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
