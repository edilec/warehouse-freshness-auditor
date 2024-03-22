# Warehouse Freshness Auditor

Compare the refresh timestamps in an exported snapshot against the per-table
deadlines a policy declares, at an instant you supply, and say which tables are
late and why.

- **Repository:** [edilec/warehouse-freshness-auditor](https://github.com/edilec/warehouse-freshness-auditor)
- **Area:** Data & Analytics
- **License:** MIT

## Why it exists

A freshness check has two failure modes that look identical in most tools.

The first is a table whose last refresh nobody recorded. It is not fresh and it
is not late — nothing in the documents says which — and a check that quietly
counts it as fine has turned a monitoring gap into a green build. Here it is
`refresh-history-absent`: the report says `incomplete` and the process exits
`2`. The same answer covers a table the snapshot does not hold, a snapshot that
disagrees with itself about a table, and a refresh dated after the instant you
passed. **Absent history is never a pass, and it is never a failure either.**

The second is a table that is provably late for a reason this run cannot
establish. Saying nothing about the cause reads as "nothing upstream is at
fault", which is a **positive** claim about upstream tables the run may never
have evaluated. So the lateness is reported as the established fact it is, and
`cause-undetermined` is reported beside it, naming the upstreams it could not
judge. Two facts, two findings.

When the lineage *can* be walked, the cause is carried the whole way: a late
table names the chain to its far end, and only the table with no late upstream
is blamed for itself.

## What it does not do

- It **reads no clock**. There is no `Date.now()`, no argument-free `new Date()`
  and no `Date.parse` anywhere in this tool. `--now` is required and has no
  default. Two runs over the same documents produce byte-identical stdout.
- It **reaches nothing**. No connection is opened, no host resolved, no
  warehouse contacted. Every input is a document somebody exported.
- It **writes no file**. The report goes to stdout. Redirect it if you want to
  keep it. There is no `--out` and no auto-fix.
- It **assumes no working week and no deadline**. Every `maxAgeMinutes` comes
  from the policy, and "non-business day" means only what `calendar.businessDays`
  says. A table that asks to be suspended on a non-business day with no working
  week declared is a configuration error, not an assumption.
- It **does not compute a business-hours-adjusted age**. A suspended table is
  not compared against its deadline at all; its age is not recalculated to
  exclude weekends or maintenance. That is a deliberate limit, not an omission.
- It **confines no path**. `--policy` and `--snapshot` are two documents you
  name, so a symbolically linked parent directory is followed, exactly as it is
  for `cp` and shell redirection. Since nothing is written, this costs nothing.
- It **parses no SQL**. Lineage comes from the snapshot's `upstream` edges.

## Quick start

```sh
node bin/warehouse-freshness-auditor.mjs \
  --policy examples/clean/freshness.policy.json \
  --snapshot examples/clean/snapshot.json \
  --now 2026-09-18T09:00:00Z
```

That run exits `0` with an empty `findings` array. The other two examples show
the other two exit codes:

```sh
# raw.orders is late, and the two tables downstream of it name the chain
# back to it rather than being blamed for themselves. Exit 1.
node bin/warehouse-freshness-auditor.mjs \
  --policy examples/failing/freshness.policy.json \
  --snapshot examples/failing/snapshot.json --now 2026-09-18T09:00:00Z

# one table has no lastRefreshAt and no completed run: neither fresh nor
# late, and the run says so instead of guessing. Exit 2.
node bin/warehouse-freshness-auditor.mjs \
  --policy examples/unknown/freshness.policy.json \
  --snapshot examples/unknown/snapshot.json --now 2026-09-18T09:00:00Z
```

## Inputs

### The policy (`--policy`)

Configuration. A problem with it means the run never had a subject, so stdout
stays empty and the message goes to stderr.

```json
{
  "schemaVersion": "1",
  "limits": { "maxSnapshotAgeMinutes": 120, "maxLineageDepth": 8 },
  "calendar": {
    "offsetMinutes": 0,
    "businessDays": ["monday", "tuesday", "wednesday", "thursday", "friday"],
    "maintenanceWindows": [
      { "id": "weekly-vacuum", "start": "2026-09-19T01:00:00Z", "end": "2026-09-19T03:00:00Z" }
    ]
  },
  "tables": [
    { "name": "raw.orders", "maxAgeMinutes": 60 },
    { "name": "mart.orders_daily", "maxAgeMinutes": 120, "suspendOnNonBusinessDays": true },
    { "name": "mart.inventory_daily", "maxAgeMinutes": 180, "suspendDuringMaintenance": true }
  ]
}
```

Every object is closed against unknown keys, including `limits`. A
one-character typo in a limit name, or in `suspendOnNonBusinessDays`, is refused
rather than silently restoring the default.

A maintenance window may carry `"tables": [...]` to apply to only those tables;
left out, it applies to every table that opts in. A window naming a table the
policy does not govern is refused, because it could never apply.

`calendar` is optional in full. `offsetMinutes` shifts where a day begins when
deciding which weekday an instant falls on; it affects nothing else.

### The snapshot (`--snapshot`)

Evidence. A problem with it is a finding inside an `incomplete` report, because
a consumer needs to know which state was not established.

```json
{
  "schemaVersion": "1",
  "generatedAt": "2026-09-18T09:00:00Z",
  "tables": [
    { "name": "raw.orders", "lastRefreshAt": "2026-09-18T08:30:00Z", "upstream": [] },
    { "name": "mart.orders_daily", "upstream": ["raw.orders"] }
  ],
  "runs": [
    {
      "table": "mart.orders_daily",
      "runId": "run-1041",
      "state": "complete",
      "startedAt": "2026-09-18T08:35:00Z",
      "endedAt": "2026-09-18T08:45:00Z"
    }
  ]
}
```

A table's last refresh comes from `lastRefreshAt`, or from the latest `complete`
run that says when it ended. Run states are `aborted`, `complete`, `failed` and
`running`; only `complete` establishes a refresh, and a `complete` run with no
`endedAt` is refused rather than treated as one.

When both `lastRefreshAt` and a later completed run are present, the snapshot
disagrees with itself. Neither value is chosen: that is
`refresh-history-conflict`.

A key this tool does not read stops the document rather than being ignored, so
a snapshot carrying evidence in a field this version cannot see is never treated
as though it had been understood.

`startedAt` is the one accepted key whose value nothing reads. It is still
checked: it must be an instant in one of the two shapes below, exactly as
`endedAt` must, because a key this tool accepts is a key it says it understands.

### Instants

Only `YYYY-MM-DD` and `YYYY-MM-DDTHH:MM:SS[.sss]Z`, in UTC. `Date.parse` is not
used anywhere: it accepts implementation-defined formats, reads a bare date-time
as local time, and rolls `2026-02-30` forward into March. Hour 24 and a leap
second are refused, because neither can be ordered against another instant
without inventing what the exporter meant.

## Findings

| Rule id | Severity | Means the run did not reach a verdict |
| --- | --- | --- |
| `cause-undetermined` | error | yes |
| `finding-limit-exceeded` | error | yes |
| `lineage-cycle` | error | yes |
| `lineage-depth-exceeded` | error | yes |
| `no-deadline-in-force` | info | no |
| `no-tables-checked` | error | yes |
| `policy-table-absent` | error | yes |
| `refresh-history-absent` | error | yes |
| `refresh-history-conflict` | error | yes |
| `refresh-in-future` | error | yes |
| `sla-suspended-maintenance` | info | no |
| `sla-suspended-non-business-day` | info | no |
| `snapshot-ahead-of-clock` | error | yes |
| `snapshot-invalid` | error | yes |
| `snapshot-not-utf8` | error | yes |
| `snapshot-schema-unsupported` | error | yes |
| `snapshot-stale` | error | yes |
| `snapshot-too-large` | error | yes |
| `snapshot-too-many-runs` | error | yes |
| `snapshot-too-many-tables` | error | yes |
| `snapshot-unparsable` | error | yes |
| `snapshot-unreadable` | error | yes |
| `table-late` | error | no |
| `table-late-upstream` | error | no |
| `upstream-limit-exceeded` | error | yes |
| `upstream-unknown` | error | yes |

Any finding in the right-hand column makes the whole report `incomplete` and the
process exit `2`, whatever that finding's own severity is. The five ids outside
it are the two lateness verdicts — answers the run did establish — and the three
notices that a deadline was not in force.

Findings sort by `(location.file, location.pointer, ruleId, message)`, each
compared by UTF-16 code unit. `localeCompare` and `Intl.Collator` are not used:
their collation depends on ICU data that varies between Node builds.

`location.file` is the snapshot document's base name, never an absolute host
path, and it is the same in every finding of one report because one report
describes one snapshot. `location.pointer` is a JSON Pointer into that document:
`/generatedAt`, `/tables/<index>`, `/tables/<index>/lastRefreshAt`,
`/runs/<index>`, `/runs/<index>/startedAt` or `/runs/<index>/endedAt`.

## Suspension, and what a suspended run reports

A table is suspended only when it opts in, and only for the instant given:

- `suspendOnNonBusinessDays` — the weekday of `--now`, shifted by
  `calendar.offsetMinutes`, is not in `calendar.businessDays`.
- `suspendDuringMaintenance` — `--now` falls inside a window that applies to the
  table. Windows are half open, `[start, end)`: a window that ends exactly at
  this instant is over.

A suspended table is not compared against its deadline and is counted under
`summary.suspended` rather than `summary.checked`. That is a policy decision the
run carried out, not a gap in evidence, so it does not make the run
`incomplete` — but it is never silent either. When a run compares **no** table
against a deadline because everything was suspended, it also emits
`no-deadline-in-force`, so `status: "pass"` cannot be read as "everything is
fresh".

Suspension governs reporting, not arithmetic. When a suspended table appears in
another table's lineage, it is still judged against its own deadline for the
purpose of attributing a cause -- it has still not refreshed, and that is still
why a governed descendant of it is late.

The finding that names it says which fact it rests on. It reports the upstream's
age and the limit the policy has taken out of force for it, naming the
suspension, rather than asserting the upstream is above a limit in the same
report that says it was not compared against one; and it suggests deciding in
the policy whether the descendant is suspended alongside it, rather than
recovering a table the policy deliberately excused.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every governed table was within its deadline, or had it suspended by the policy |
| `1` | the check completed and at least one table is late |
| `2` | invalid configuration, or evidence the check could not obtain |

A late table whose cause could not be settled exits `2` rather than `1`: the
cause is part of what this tool exists to report, and `cause-undetermined` says
so. Governing the upstream tables in the policy is what turns such a run into a
clean exit `1` with the chain named.

Exit `2` has two shapes, and the difference is deliberate:

| Situation | stdout | stderr |
| --- | --- | --- |
| invalid configuration, unknown option, bad policy, missing `--now` | **empty** | the message |
| a snapshot that could not be read, or a table that was not established | an `incomplete` report | optional diagnostics |

A consumer that pipes stdout must handle an empty stdout on exit `2`. Emitting a
fake report for a run that never started would be worse.

## Limits

Every bound is enforced **before** the work it bounds, not after. The snapshot's
size is taken from `stat` before the file is opened.

| Limit | Default | Ceiling | Configurable |
| --- | ---: | ---: | --- |
| policy document bytes | 1048576 | 1048576 | no |
| tables per policy | 2048 | 2048 | no |
| maintenance windows | 256 | 256 | no |
| `maxAgeMinutes` per table | — | 525600 | no |
| `calendar.offsetMinutes` | 0 | ±1440 | no |
| identifier length | 128 | 128 | no |
| `limits.maxSnapshotBytes` | 4194304 | 16777216 | yes |
| `limits.maxTables` | 5000 | 20000 | yes |
| `limits.maxRuns` | 20000 | 100000 | yes |
| `limits.maxUpstreamPerTable` | 64 | 256 | yes |
| `limits.maxLineageDepth` | 16 | 64 | yes |
| `limits.maxSnapshotAgeMinutes` | 1440 | 43200 | yes |
| findings per audit | 50000 | 50000 | no |

A policy may **lower** a configurable bound and may never raise one past its
ceiling: a limit a document could raise would be no limit at all. Exceeding a
bound is an `incomplete` result with a finding naming the limit, never a silent
truncation and never a pass.

`limits.maxLineageDepth` counts edges. A chain of exactly that many edges is
walked to its far end; only a longer one is refused, and a table whose chain was
cut reports its lateness together with `lineage-depth-exceeded` rather than
being reported as late for a local reason.

The findings bound is on the WORK, not only on the input. `upstream-unknown` is
raised once per unreadable lineage edge, and the declared limits allow far more
of them than a report can carry: 1280 governed tables each naming 256 absent
upstreams fits inside the 16 MiB snapshot ceiling and produced 327,680 findings,
a 134 MB report and a 1.25 GB peak RSS. Reaching the bound is never a silent
truncation — the audit stops emitting and adds `finding-limit-exceeded`, so the
run is `incomplete` and exits `2`. That one finding is added whatever the count,
because it is the finding the limit may not drop, so a report that reached the
bound carries 50001.

The snapshot's completed runs are indexed once when it is read, and each table
in a lineage walk is classified and sorted once per run rather than once per
descendant, so a freshness question costs the same whatever the run history
holds and a shared chain is not re-walked for every table that hangs off it.

Measured on this tool, on a 16-core machine whose load average moved between
about 50 and 400 while these were taken. Wall time therefore measures the
machine as much as the tool, and is given for context only; the CPU column is
the one to compare.

| Input | CPU (user) | Wall | Peak RSS | Findings |
| --- | ---: | ---: | ---: | ---: |
| ceiling, work-shaped: 20000 tables, 100000 runs, 10.9 MB, 2048 governed, a 64-edge chain, 256 upstream per node | 3.6 s | 4.4 s | 362 MB | 20417 |
| the same, before the lineage walk was made once-per-node | 21.4 s | 141.7 s | 519 MB | 20417 |
| ceiling, output-shaped: 1280 governed tables each naming 256 absent upstreams, 16.0 MB — the findings bound fires | 1.8 s | 4.6 s | 459 MB | 50001 |

The second row is kept because it is the measurement that found the defect, and
its report is **byte-identical** to the first: walking each lineage node once
changed how long the run takes and nothing about what it says.

Before either change, the third input did not finish at all. It ended with
`Maximum call stack size exceeded`, an empty stdout and exit `2`.

## Verification

```sh
npm run check
```

That runs `node --check` over every source and test file, the `node:test` suite,
all three examples with their expected exit codes, and `npm pack --dry-run`.

## Approach

The run-record and lineage vocabulary follows the conventions of
[OpenLineage](https://github.com/OpenLineage/OpenLineage); the calendar and
window model follows [cron-parser](https://github.com/harrisiirak/cron-parser)
in taking every schedule fact from an explicit declaration rather than from the
host. Neither is a dependency: this package has no runtime and no development
dependencies at all.

## License

MIT. See [LICENSE](./LICENSE).
